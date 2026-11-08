// Clash of GPTs — mirrors the native BrowserOS multi-pane comparison view
// (clash_of_gpts_coordinator.cc: pane_count / pane_providers / last_urls).

const DEFAULT_PROVIDERS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { name: 'Qwen', url: 'https://chat.qwen.ai/' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai/' }
];

const grid = document.getElementById('grid');
const chips = document.getElementById('chips');

let providers = DEFAULT_PROVIDERS.slice();
let active = [0, 1, 2, 3]; // pane_providers

async function loadState() {
  const stored = await chrome.storage.local.get(['providers', 'comparePaneIndexes']);
  if (Array.isArray(stored.providers) && stored.providers.length) providers = stored.providers;
  if (Array.isArray(stored.comparePaneIndexes) && stored.comparePaneIndexes.length) {
    active = stored.comparePaneIndexes.filter((i) => Number.isInteger(i) && i < providers.length);
  }
  if (!active.length) active = providers.map((_, i) => i).slice(0, 4);
}

function renderChips() {
  chips.replaceChildren(
    ...providers.map((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.name || p.url;
      b.setAttribute('aria-pressed', String(active.includes(i)));
      b.addEventListener('click', () => toggle(i));
      return b;
    })
  );
}

function pane(index) {
  const provider = providers[index];
  const wrap = document.createElement('section');
  wrap.className = 'pane';

  const bar = document.createElement('div');
  bar.className = 'pane-bar';

  const label = document.createElement('span');
  label.textContent = provider.name || provider.url;

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = 'Reload';
  reloadBtn.title = 'Reload this pane';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.textContent = 'Open tab';
  openBtn.title = 'Open in a normal tab';

  const frame = document.createElement('iframe');
  frame.title = provider.name;
  frame.allow = 'microphone; camera; clipboard-read; clipboard-write; fullscreen; autoplay';
  frame.src = provider.url;

  reloadBtn.addEventListener('click', () => {
    frame.src = 'about:blank';
    setTimeout(() => { frame.src = provider.url; }, 40);
  });
  openBtn.addEventListener('click', () => chrome.tabs.create({ url: provider.url }));

  bar.append(label, reloadBtn, openBtn);
  wrap.append(bar, frame);
  return wrap;
}

function renderGrid() {
  grid.dataset.panes = String(active.length);
  if (!active.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'Pick at least one provider above.';
    grid.replaceChildren(p);
    return;
  }
  if (active.length === 3) {
    // 2 columns, second row gets the third pane plus empty filler
    grid.style.gridTemplateRows = '1fr 1fr';
  }
  grid.replaceChildren(...active.map((i) => pane(i)));
}

async function toggle(index) {
  active = active.includes(index) ? active.filter((i) => i !== index) : [...active, index].sort((a, b) => a - b);
  await chrome.storage.local.set({ comparePaneIndexes: active });
  renderChips();
  renderGrid();
}

(async function init() {
  await loadState();
  renderChips();
  renderGrid();
})();
