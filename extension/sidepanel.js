// AI Chat Sidebar — side panel controller.
// Mirrors the native BrowserOS "Chat" (ThirdPartyLlm) panel.
//
// Toolbar: three frequent actions on the trailing edge (copy, screenshot, reset)
// plus an overflow menu for everything rare. Copy + screenshot act on the page
// the user is browsing (the active tab), and each offers a scope choice:
//   copy      -> page content only (default) | whole page
//   screenshot-> visible area (default) | full page | selected area

const DEFAULT_PROVIDERS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { name: 'Qwen', url: 'https://chat.qwen.ai/' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai/' }
];

const $ = (id) => document.getElementById(id);

const els = {
  pickerBtn: $('picker-btn'),
  pickerMenu: $('picker-menu'),
  pickerLabel: $('picker-label'),
  frame: $('frame'),
  note: $('note'),
  noteText: $('note-text'),
  noteAction: $('note-action'),
  noteClose: $('note-close'),
  menuBtn: $('btn-menu'),
  menu: $('menu'),
  toast: $('toast'),
  settings: $('settings'),
  settingsClose: $('settings-close'),
  providerList: $('provider-list'),
  addProvider: $('add-provider'),
  resetProviders: $('reset-providers'),
  copyBtn: $('btn-copy'),
  shotBtn: $('btn-shot'),
  resetBtn: $('btn-reset')
};

let providers = DEFAULT_PROVIDERS.slice();
let selectedIndex = 0;
let loadTimer = null;
let toastTimer = null;
let saveTimer = null;
let busy = false;

/* ------------------------------------------------------------------ state */

async function loadState() {
  const stored = await chrome.storage.local.get(['providers', 'selectedIndex']);
  providers = Array.isArray(stored.providers) && stored.providers.length ? stored.providers : DEFAULT_PROVIDERS.slice();
  selectedIndex = Number.isInteger(stored.selectedIndex) && stored.selectedIndex < providers.length ? stored.selectedIndex : 0;
}

async function persist() {
  await chrome.storage.local.set({ providers, selectedIndex });
}

function currentProvider() {
  return providers[selectedIndex] ?? providers[0];
}

/* ------------------------------------------------------------------ toast */

function toast(message, isError = false) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.dataset.kind = isError ? 'error' : 'ok';
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 6000 : 2600);
}

/* --------------------------------------------------------- target tab */

function isWebTab(tab) {
  return /^https?:/i.test(tab?.url ?? '');
}

// The menu acts on the page being browsed, never on this extension page.
async function resolveTargetTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isWebTab(active)) return active;

  const all = await chrome.tabs.query({ lastFocusedWindow: true });
  const web = all.filter(isWebTab).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  if (web.length) return web[0];
  throw new Error('no web page is open in this window');
}

/* ---------------------------------------------------------- clipboard */

// Clipboard writes need a focused document; fall back to the legacy command.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

async function toBlob(image) {
  if (image instanceof Blob) return image;
  return (await fetch(`data:image/png;base64,${image}`)).blob();
}

// Clipboard is the delivery path that can actually reach an AI chat input
// rendered inside a cross-origin iframe. Downloading stays a last resort.
async function deliverImage(image, label) {
  const blob = await toBlob(image);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(`${label} copied — press Ctrl+V in the chat`);
  } catch {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `browseros-page-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Clipboard refused image — downloaded PNG instead');
  }
}

// Vertically stacks the selected areas into a single image.
async function stackTiles(tiles) {
  const bitmaps = [];
  for (const tile of tiles) {
    const blob = await (await fetch(`data:image/png;base64,${tile.base64}`)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }
  const gap = 10;
  const width = Math.max(...bitmaps.map((b) => b.width));
  const height = bitmaps.reduce((sum, b) => sum + b.height, 0) + gap * (bitmaps.length - 1);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.min(height, 16000);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const bmp of bitmaps) {
    if (y + bmp.height > canvas.height) break;
    ctx.drawImage(bmp, 0, y);
    y += bmp.height + gap;
  }
  return new Promise((r) => canvas.toBlob(r, 'image/png'));
}

// Selected areas land in the chat: copy the image, then focus the chat frame so
// a single Ctrl+V drops it into the provider's input.
async function copyImageToChat(blob, count) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    document.getElementById('frame')?.focus();
    toast(`${count} area${count > 1 ? 's' : ''} copied — press Ctrl+V in the chat`, false);
  } catch {
    await deliverImage(blob, `${count} area${count > 1 ? 's' : ''}`);
  }
}

/* ---------------------------------------------------- page text extraction */

// Runs INSIDE the page. Prefers semantic containers (article/main), falls back
// to the body with page chrome (nav/header/footer/aside/…) hidden for a moment.
function extractPageContent() {
  const CHROME = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[aria-hidden="true"]';
  const TEXT = 'script,style,noscript,template,svg,canvas,iframe,form,button,input,select,textarea';

  const clean = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const textOf = (el) => clean(el?.innerText ?? '');

  const semantic = ['article', 'main', '[role="main"]', '#main', '#content', '#main-content', '.post', '.article', '.entry-content', '.post-content', '.markdown-body'];
  let best = { score: 0, text: '' };
  for (const sel of semantic) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(sel)]; } catch { continue; }
    for (const node of nodes) {
      const t = textOf(node);
      // prefer the longest, but never a container that is just a wrapper for the whole page
      if (t.length > best.score && t.length < textOf(document.body).length * 0.95) best = { score: t.length, text: t };
    }
  }
  if (best.score >= 200) return { text: best.text, strategy: 'semantic' };

  // fallback: hide page chrome, read the body, restore
  const hidden = [];
  try {
    for (const sel of CHROME.split(',')) {
      for (const node of document.querySelectorAll(sel.trim())) {
        hidden.push([node, node.style.getPropertyValue('display'), node.style.getPropertyPriority('display')]);
        node.style.setProperty('display', 'none', 'important');
      }
    }
    for (const sel of TEXT.split(',')) {
      for (const node of document.querySelectorAll(sel.trim())) {
        hidden.push([node, node.style.getPropertyValue('display'), node.style.getPropertyPriority('display')]);
        node.style.setProperty('display', 'none', 'important');
      }
    }
    return { text: textOf(document.body), strategy: 'fallback' };
  } finally {
    for (const [node, value, priority] of hidden) {
      if (value) node.style.setProperty('display', value, priority);
      else node.style.removeProperty('display');
    }
  }
}

async function readWholePageText(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => document.body?.innerText ?? ''
  });
  const texts = results.map((r) => r.result ?? '').filter((t) => t.trim().length);
  texts.sort((a, b) => b.length - a.length);
  return texts[0] ?? '';
}

async function readContentOnly(tab) {
  const [first] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent
  });
  return first?.result ?? { text: '', strategy: 'none' };
}

/* --------------------------------------------------------- screenshot */

async function captureVisible(tab) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (!dataUrl?.startsWith('data:image/png')) throw new Error('capture returned no image');
  return dataUrl.split(',')[1];
}

// A selected area is always inside the visible viewport (the overlay covers the
// viewport only), so cropping a viewport capture is enough — no debugger needed.
async function captureCrop(tab, rect, viewportWidth) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = bmp.width / viewportWidth;

  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(Math.round(rect.width * scale), bmp.width - sx);
  const sh = Math.min(Math.round(rect.height * scale), bmp.height - sy);
  if (sw <= 0 || sh <= 0) throw new Error('selection is outside the visible area');

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return await blobToBase64(blob);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('could not encode image'));
    reader.readAsDataURL(blob);
  });
}

// Full page = scroll + capture each viewport + stitch. Chrome's
// `captureBeyondViewport` repeats content on many real sites (fixed/sticky
// headers, vh-based sections), so we never rely on it for the whole page.
// The stepping is animated on purpose: the user sees the page scrolling and
// knows a capture is in progress.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function injectScrollTo(y) {
  return window.scrollTo({ top: y, left: 0, behavior: 'smooth' });
}

async function scrollToY(tabId, y) {
  await chrome.scripting.executeScript({ target: { tabId }, func: injectScrollTo, args: [y] });
  // wait until the smooth scroll settles (or a timeout)
  let last = -1;
  for (let i = 0; i < 30; i++) {
    await sleep(60);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Math.round(window.scrollY)
    });
    if (result === last) return result;
    last = result;
  }
  return last;
}

// Hide fixed/sticky chrome so it does not repeat on every tile.
function injectFreezeChrome() {
  const frozen = [];
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') {
      frozen.push([el, el.style.visibility]);
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  window.__llmFrozen = frozen;
  return frozen.length;
}

function injectRestoreChrome() {
  const frozen = window.__llmFrozen ?? [];
  for (const [el, value] of frozen) {
    if (value) el.style.setProperty('visibility', value);
    else el.style.removeProperty('visibility');
  }
  window.__llmFrozen = [];
  return frozen.length;
}

function injectMetrics() {
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    // innerWidth includes the classic scrollbar, clientWidth does not
    scrollbarWidth: Math.max(0, window.innerWidth - document.documentElement.clientWidth),
    dpr: window.devicePixelRatio || 1,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
  };
}

async function stitchTiles(tiles) {
  // tiles: [{ base64, y, viewportHeight, scale }] in page CSS pixels
  const bitmaps = [];
  for (const tile of tiles) {
    const blob = await (await fetch(`data:image/png;base64,${tile.base64}`)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }

  const scale = bitmaps[0].width / tiles[0].viewportWidth;
  // drop the classic scrollbar column that captureVisibleTab includes
  const trimRight = Math.round((tiles[0].scrollbarWidth ?? 0) * scale);
  const maxHeight = bitmaps.reduce((m, b, i) => Math.max(m, tiles[i].y + b.height / scale), 0);
  const width = Math.max(1, bitmaps[0].width - trimRight);
  const height = Math.min(Math.round(maxHeight) * 1, 16000 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let covered = 0; // page CSS px already painted
  for (let i = 0; i < bitmaps.length; i++) {
    const bmp = bitmaps[i];
    const tile = tiles[i];
    const tileHeight = bmp.height / scale;
    const skip = Math.max(0, covered - tile.y); // overlap already painted
    if (skip >= tileHeight) continue;
    const srcY = Math.round(skip * scale);
    ctx.drawImage(
      bmp,
      0, srcY, bmp.width, bmp.height - srcY,
      0, Math.round((tile.y + skip) * scale), bmp.width, bmp.height - srcY
    );
    covered = Math.max(covered, tile.y + tileHeight);
  }

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob;
}

async function captureFullPage(tab) {
  const [{ result: metrics }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectMetrics });
  const { innerHeight, scrollHeight, scrollY } = metrics;
  if (!innerHeight || scrollHeight <= 0) throw new Error('cannot measure the page');

  const maxY = Math.max(0, scrollHeight - innerHeight);
  const positions = [];
  for (let y = 0; y < maxY; y += innerHeight) positions.push(y);
  positions.push(maxY);
  const unique = [...new Set(positions)];

  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectFreezeChrome });
  const tiles = [];
  try {
    for (let i = 0; i < unique.length; i++) {
      const targetY = unique[i];
      toast(`Capturing full page… ${i + 1}/${unique.length}`);
      const actualY = await scrollToY(tab.id, targetY);
      await sleep(550); // respect captureVisibleTab rate limit (2/s) + let paint settle
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      tiles.push({
        base64: dataUrl.split(',')[1],
        y: actualY,
        viewportHeight: innerHeight,
        viewportWidth: metrics.innerWidth
      });
      if (tiles.length >= 40) break; // safety cap for very long pages
    }
  } finally {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectRestoreChrome }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectScrollTo, args: [scrollY] }).catch(() => {});
  }

  return stitchTiles(tiles.map((t) => ({
    ...t,
    viewportWidth: metrics.innerWidth,
    scrollbarWidth: metrics.scrollbarWidth ?? 0
  })));
}

async function captureRegion(tab, rect) {
  const [{ result: metrics }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectMetrics });
  return captureCrop(tab, rect, metrics.innerWidth);
}

// Multi-area picker: drag as many rectangles as needed, Enter finishes,
// Esc cancels. Returns viewport-space rects.
function pickRegions() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-llm-region', '');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(15,17,21,0.28)';

    const hint = document.createElement('div');
    hint.textContent = 'Drag to select areas · Enter = done · Esc = cancel';
    hint.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:7px 14px;border-radius:9px;background:#23262b;color:#eef1f5;font:12px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none';

    const counter = document.createElement('div');
    counter.style.cssText = 'position:fixed;top:12px;right:12px;padding:6px 10px;border-radius:8px;background:#6b7cff;color:#fff;font:12px system-ui;pointer-events:none';
    counter.textContent = '0 areas';

    overlay.append(hint, counter);
    document.documentElement.appendChild(overlay);

    const rects = [];
    let start = null;
    let live = null;

    const drawLive = (rect) => {
      if (!live) {
        live = document.createElement('div');
        live.style.cssText = 'position:fixed;border:2px dashed #6b7cff;background:rgba(107,124,255,0.16);pointer-events:none;z-index:2147483646';
        overlay.appendChild(live);
      }
      live.style.left = `${rect.x}px`;
      live.style.top = `${rect.y}px`;
      live.style.width = `${rect.width}px`;
      live.style.height = `${rect.height}px`;
    };

    const onDown = (e) => {
      start = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      e.stopPropagation();
    };

    const onMove = (e) => {
      if (!start) return;
      drawLive({
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y)
      });
    };

    const onUp = (e) => {
      if (!start) return;
      const rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y)
      };
      start = null;
      if (live) { live.remove(); live = null; }
      if (rect.width < 8 || rect.height < 8) return;

      rects.push(rect);
      counter.textContent = `${rects.length} area${rects.length > 1 ? 's' : ''}`;

      const marker = document.createElement('div');
      marker.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #6b7cff;background:rgba(107,124,255,0.10);pointer-events:none;z-index:2147483645`;
      const badge = document.createElement('span');
      badge.textContent = String(rects.length);
      badge.style.cssText = 'position:absolute;top:-9px;left:-9px;width:18px;height:18px;border-radius:9px;background:#6b7cff;color:#fff;font:11px/18px system-ui;text-align:center';
      marker.appendChild(badge);
      overlay.appendChild(marker);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve([]); }
      else if (e.key === 'Enter') { cleanup(); resolve(rects); }
    };

    function cleanup() {
      overlay.remove();
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    }

    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
  });
}

/* -------------------------------------------------------------- actions */

async function copyPage(mode = 'content') {
  if (busy) return;
  busy = true;
  toast(mode === 'whole' ? 'Copying whole page…' : 'Extracting page content…');
  try {
    const tab = await resolveTargetTab();
    let text;
    let label;
    if (mode === 'whole') {
      text = await readWholePageText(tab);
      label = 'whole page';
    } else {
      const res = await readContentOnly(tab);
      text = res.text;
      label = res.strategy === 'semantic' ? 'page content' : 'page content (no article found)';
    }
    if (!text.trim()) throw new Error('no text found on the page');
    const ok = await copyText(text);
    toast(
      ok ? `Copied ${label} — ${text.length.toLocaleString()} chars from "${tab.title || tab.url}"`
         : 'Copy blocked by the browser (document not focused)',
      !ok
    );
  } catch (err) {
    toast('Copy failed: ' + (err?.message ?? err), true);
  } finally {
    busy = false;
  }
}

async function screenshotPage(mode = 'visible') {
  if (busy) return;
  busy = true;
  try {
    const tab = await resolveTargetTab();

    if (mode === 'visible') {
      toast('Capturing visible area…');
      await deliverImage(await captureVisible(tab), `Visible area of "${tab.title || tab.url}"`);
      return;
    }

    if (mode === 'full') {
      toast('Capturing full page… the page will scroll');
      const blob = await captureFullPage(tab);
      await deliverImage(blob, `Full page "${tab.title || tab.url}"`);
      return;
    }

    if (mode === 'region') {
      toast('Drag on the page to select areas — Enter when done');
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pickRegions });
      const rects = injected?.result ?? [];
      if (!rects.length) { toast('Selection cancelled'); return; }

      // Selections are captured from the visible viewport, so rects stay in
      // viewport coordinates — no scroll offset involved.
      const tiles = [];
      for (let i = 0; i < rects.length; i++) {
        toast(`Capturing area ${i + 1}/${rects.length}…`);
        const r = rects[i];
        tiles.push({ base64: await captureRegion(tab, r), y: 0, viewportWidth: r.width });
      }

      const blob = tiles.length === 1
        ? await (await fetch(`data:image/png;base64,${tiles[0].base64}`)).blob()
        : await stackTiles(tiles);
      await copyImageToChat(blob, rects.length);
      return;
    }
  } catch (err) {
    toast('Screenshot failed: ' + (err?.message ?? err), true);
  } finally {
    busy = false;
  }
}

function resetChat() {
  if (!currentProvider()) return;
  closeMenu();
  els.frame.src = 'about:blank';
  setTimeout(() => { renderFrame(); toast('LLM chat reset'); }, 60);
}

async function reload() {
  if (!currentProvider()) return;
  els.frame.src = 'about:blank';
  await new Promise((r) => setTimeout(r, 30));
  renderFrame();
}

async function openPopup() {
  const provider = currentProvider();
  if (!provider) return;
  await chrome.runtime.sendMessage({ type: 'openPopup', url: provider.url });
}

async function openTab() {
  const provider = currentProvider();
  if (!provider) return;
  await chrome.runtime.sendMessage({ type: 'openTab', url: provider.url });
}

async function openCompare() {
  await chrome.runtime.sendMessage({ type: 'openCompare' });
}

/* ------------------------------------------------------------- rendering */

function renderPicker() {
  els.pickerLabel.textContent = currentProvider()?.name ?? 'No provider';
  els.pickerMenu.replaceChildren(
    ...providers.map((p, i) => {
      const li = document.createElement('li');
      li.role = 'option';
      li.textContent = p.name || p.url;
      li.title = p.url;
      li.dataset.index = String(i);
      li.setAttribute('aria-selected', String(i === selectedIndex));
      li.addEventListener('click', () => selectProvider(i));
      return li;
    })
  );
}

function closePicker() {
  els.pickerMenu.hidden = true;
  els.pickerBtn.setAttribute('aria-expanded', 'false');
}

function togglePicker() {
  const open = els.pickerMenu.hidden;
  els.pickerMenu.hidden = !open;
  els.pickerBtn.setAttribute('aria-expanded', String(open));
  if (open) closeMenu();
}

function closeMenu() {
  els.menu.hidden = true;
  els.menuBtn.setAttribute('aria-expanded', 'false');
}

function toggleMenu() {
  const open = els.menu.hidden;
  els.menu.hidden = !open;
  els.menuBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    closePicker();
    const first = els.menu.querySelector('[role="menuitem"]');
    first?.focus();
  }
}

function hideNote() { els.note.hidden = true; }
function showNote(text) { els.noteText.textContent = text; els.note.hidden = false; }

function renderFrame() {
  const provider = currentProvider();
  if (!provider) return;
  hideNote();
  els.frame.src = provider.url;

  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    showNote(`${provider.name} did not load inside the panel — it may block embedding.`);
  }, 12000);
}

async function selectProvider(index) {
  selectedIndex = index;
  await persist();
  renderPicker();
  closePicker();
  renderFrame();
}

/* --------------------------------------------------------------- settings */

function renderProviderRows() {
  els.providerList.replaceChildren(
    ...providers.map((p, i) => {
      const li = document.createElement('li');
      li.className = 'provider-row' + (i === selectedIndex ? ' is-active' : '');

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'pick' + (i === selectedIndex ? ' is-active' : '');
      pick.title = 'Use this provider';
      pick.setAttribute('aria-label', `Use ${p.name}`);
      pick.addEventListener('click', async () => {
        await selectProvider(i);
        renderProviderRows();
      });

      const name = document.createElement('input');
      name.type = 'text';
      name.value = p.name;
      name.placeholder = 'Name';
      name.setAttribute('aria-label', `Provider ${i + 1} name`);
      name.addEventListener('input', () => { providers[i].name = name.value; scheduleSave(); });

      const url = document.createElement('input');
      url.type = 'url';
      url.value = p.url;
      url.placeholder = 'https://…';
      url.setAttribute('aria-label', `Provider ${i + 1} URL`);
      url.addEventListener('input', () => { providers[i].url = url.value; scheduleSave(); });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '×';
      remove.title = 'Remove provider';
      remove.addEventListener('click', () => {
        if (providers.length <= 1) return;
        providers.splice(i, 1);
        selectedIndex = Math.min(selectedIndex, providers.length - 1);
        renderProviderRows();
        renderPicker();
        renderFrame();
        scheduleSave();
      });

      li.append(pick, name, url, remove);
      return li;
    })
  );
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await persist();
    await chrome.runtime.sendMessage({ type: 'resyncRules' });
  }, 400);
}

function showSettings() {
  renderProviderRows();
  els.settings.hidden = false;
  closeMenu();
  closePicker();
}

function hideSettings() {
  els.settings.hidden = true;
  renderPicker();
  renderFrame();
}

/* ----------------------------------------------------------------- wiring */

const ACTIONS = {
  'copy-content': () => copyPage('content'),
  'copy-whole': () => copyPage('whole'),
  'shot-visible': () => screenshotPage('visible'),
  'shot-full': () => screenshotPage('full'),
  'shot-region': () => screenshotPage('region'),
  reload,
  'open-tab': openTab,
  'open-popup': openPopup,
  compare: openCompare,
  settings: showSettings
};

els.menu.addEventListener('click', (e) => {
  const item = e.target.closest('[role="menuitem"]');
  if (!item) return;
  closeMenu();
  ACTIONS[item.dataset.action]?.();
});

els.menu.addEventListener('keydown', (e) => {
  const item = e.target.closest('[role="menuitem"]');
  if (!item) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    closeMenu();
    ACTIONS[item.dataset.action]?.();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...els.menu.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(item);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }
});

els.pickerBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePicker(); });
els.menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });

document.addEventListener('click', (e) => {
  if (!els.pickerMenu.hidden && !els.pickerMenu.contains(e.target) && e.target !== els.pickerBtn) closePicker();
  if (!els.menu.hidden && !els.menu.contains(e.target) && e.target !== els.menuBtn) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePicker(); closeMenu(); }
});

// Frequent actions: click = default scope, Alt+click = alternate scope.
els.copyBtn.addEventListener('click', (e) => copyPage(e.altKey ? 'whole' : 'content'));
els.shotBtn.addEventListener('click', (e) => screenshotPage(e.altKey ? 'full' : 'visible'));
els.resetBtn.addEventListener('click', resetChat);

els.settingsClose.addEventListener('click', hideSettings);
els.noteAction.addEventListener('click', openPopup);
els.noteClose.addEventListener('click', hideNote);

els.addProvider.addEventListener('click', () => {
  providers.push({ name: 'New provider', url: 'https://example.com/' });
  renderProviderRows();
  scheduleSave();
});

els.resetProviders.addEventListener('click', async () => {
  providers = DEFAULT_PROVIDERS.slice();
  selectedIndex = 0;
  renderProviderRows();
  renderPicker();
  await persist();
  await chrome.runtime.sendMessage({ type: 'resyncRules' });
});

els.frame.addEventListener('load', () => {
  clearTimeout(loadTimer);
  if (els.frame.src !== 'about:blank') hideNote();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.selectedIndex) return;
  selectedIndex = changes.selectedIndex.newValue ?? 0;
  renderPicker();
});

// Test hook: lets the automated harness exercise the actions without clicking.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'selftest') return;
  (async () => {
    try {
      const record = (extra) => chrome.storage.local.set({ selftest: { action: msg.action, ok: true, ...extra } });

      if (msg.action === 'copyContent' || msg.action === 'copyWhole') {
        const tab = await resolveTargetTab();
        const text = msg.action === 'copyWhole' ? await readWholePageText(tab) : (await readContentOnly(tab)).text;
        const ok = await copyText(text);
        await record({ ok, chars: text.length, tabUrl: tab.url, sample: text.slice(0, 120) });
      } else if (msg.action === 'shotFullSave') {
        const tab = await resolveTargetTab();
        const blob = await captureFullPage(tab);
        const b64 = await blobToBase64(blob);
        await record({ bytes: blob.size, b64, tabUrl: tab.url });
      } else if (msg.action === 'shotVisible') {
        const tab = await resolveTargetTab();
        const b64 = await captureVisible(tab);
        await record({ bytes: Math.round(b64.length * 0.75), tabUrl: tab.url });
      } else if (msg.action === 'shotFull') {
        const tab = await resolveTargetTab();
        const blob = await captureFullPage(tab);
        const bmp = await createImageBitmap(blob);
        await record({ bytes: blob.size, width: bmp.width, height: bmp.height, tabUrl: tab.url });
      } else if (msg.action === 'shotClip') {
        const tab = await resolveTargetTab();
        const b64 = await captureRegion(tab, { x: 0, y: 0, width: 320, height: 200 });
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        await record({ bytes: Math.round(b64.length * 0.75), width: bmp.width, height: bmp.height, tabUrl: tab.url });
      } else if (msg.action === 'regionOverlay') {
        const tab = await resolveTargetTab();
        void chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pickRegions }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        const probe = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => Boolean(document.querySelector('[data-llm-region]'))
        });
        await record({ overlay: Boolean(probe[0]?.result) });
      }
      sendResponse({ ok: true });
    } catch (err) {
      await chrome.storage.local.set({ selftest: { action: msg.action, ok: false, error: String(err?.message ?? err) } });
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true;
});

(async function init() {
  await loadState();
  renderPicker();
  renderFrame();

  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'settings') showSettings();
})();
