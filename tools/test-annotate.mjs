// Verifies v1.6.0 additions: the result tray and the annotation editor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve('extension');
const PORT = 9344;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-prof-'));
const ICON = fs.readFileSync(path.join(EXT, 'icons/128.png'));
const ICON_DATA_URL = `data:image/png;base64,${ICON.toString('base64')}`;

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,900', '--disable-dev-shm-usage',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, '--remote-debugging-port=' + PORT, 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify(p)); });
  }
}

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

try {
  let version;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
    await sleep(500);
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new CDP(ws);

  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && /\/background\.js$/.test(t.url));
    if (!sw) await sleep(400);
  }
  const extId = new URL(sw.url).host;
  const swS = await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const swEval = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swS.sessionId);
    return r.result?.value;
  };

  /* ---------------- 1. result tray ---------------- */
  await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  await sleep(1500);

  await swEval(`chrome.storage.local.remove('selftest')`);

  await swEval(`chrome.runtime.sendMessage({type:'selftest', action:'trayDemo'}).catch(e => String(e))`);
  let tray = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const raw = await swEval(`chrome.storage.local.get('selftest').then(o => JSON.stringify(o.selftest ?? null))`);
    tray = JSON.parse(raw);
    if (tray?.action === 'trayDemo') break;
  }
  check('capture shows a result tray', tray?.trayVisible === true, JSON.stringify(tray));
  check('tray offers Insert into chat', /Insert into chat/i.test(tray?.insertLabel ?? ''), tray?.insertLabel);
  check('tray labels the capture', /Demo capture/.test(tray?.label ?? ''), tray?.label);

  /* ---------------- 2. annotation editor ---------------- */
  await swEval(`chrome.storage.local.set({ 'annotate.pending': { dataUrl: ${JSON.stringify(ICON_DATA_URL)}, label: 'Test capture' } }).then(() => 'ok')`);

  const ann = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/annotate.html` });
  const annS = await cdp.send('Target.attachToTarget', { targetId: ann.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, annS.sessionId);
  await sleep(1500);

  const loaded = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      width: document.getElementById('canvas').width,
      height: document.getElementById('canvas').height,
      tools: document.querySelectorAll('.tool').length,
      swatches: document.querySelectorAll('.swatch').length,
      hasDone: !!document.getElementById('done')
    })`,
    returnByValue: true
  }, annS.sessionId);
  const L = JSON.parse(loaded.result.value);
  check('editor loads the screenshot', L.width > 0 && L.height > 0, JSON.stringify(L));
  check('editor exposes drawing tools', L.tools >= 4 && L.swatches >= 5, JSON.stringify(L));

  // draw a stroke through the real pointer pipeline, then flatten
  const drawn = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      const at = (x, y, type) => c.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1 }));
      at(20, 20, 'pointerdown');
      at(60, 60, 'pointermove');
      at(100, 90, 'pointermove');
      at(100, 90, 'pointerup');
      const before = c.toDataURL('image/png');
      document.getElementById('done').click();
      return JSON.stringify({ canvasBytes: before.length });
    })()`,
    returnByValue: true
  }, annS.sessionId);
  const D = JSON.parse(drawn.result.value);
  check('drawing produces a flattened image', D.canvasBytes > 1000, JSON.stringify(D));

  let result = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const raw = await swEval(`chrome.storage.local.get('annotate.result').then(o => JSON.stringify(o['annotate.result'] ?? null))`);
    result = JSON.parse(raw);
    if (result?.dataUrl) break;
  }
  check('Send to chat stores the annotated PNG', (result?.dataUrl ?? '').startsWith('data:image/png'), (result?.dataUrl ?? '').slice(0, 34));

  const ok = checks.every((c) => c.pass);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e), checks }, null, 2));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
