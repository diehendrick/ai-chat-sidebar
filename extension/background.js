// AI Chat Sidebar — background service worker
// Mirrors the native BrowserOS "Chat" (ThirdPartyLlm) panel:
//   * providers list persisted in storage (BrowserOS uses prefs browseros.third_party_llm.providers)
//   * selected provider persisted separately (browseros.third_party_llm.selected_provider)
//   * panel hosts the provider site itself
//
// Difference vs the native panel: an extension can only host a site inside an
// <iframe>, and most AI sites send X-Frame-Options / CSP frame-ancestors.
// We therefore strip those two response headers for sub-frames with
// declarativeNetRequest, which is what makes the embed possible in stock Chrome/Edge.

const DEFAULT_PROVIDERS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { name: 'Qwen', url: 'https://chat.qwen.ai/' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai/' }
];

const RULE_ID_BASE = 1000;
const MAX_RULES = 100; // reserved dynamic-rule id range: 1000..1099

async function getProviders() {
  const { providers } = await chrome.storage.local.get('providers');
  return Array.isArray(providers) && providers.length ? providers : DEFAULT_PROVIDERS;
}

function hostFilter(urlString) {
  try {
    const host = new URL(urlString).hostname;
    return `||${host}^`;
  } catch {
    return null;
  }
}

// Rebuild dynamic DNR rules so every configured provider host may be framed.
// Chrome rejects concurrent updateDynamicRules() calls ("Rule with id X does not
// have a unique ID"), and install/startup/storage events can all fire at once,
// so every sync goes through a single serialised queue.
let syncQueue = Promise.resolve();

function syncFrameRules() {
  syncQueue = syncQueue.then(applyFrameRules).catch((err) => {
    console.error('[chat-panel] failed to sync frame rules:', err?.message ?? err);
  });
  return syncQueue;
}

async function applyFrameRules() {
  const providers = await getProviders();
  const rules = [];
  const seen = new Set();

  for (const p of providers) {
    const filter = hostFilter(p.url);
    if (!filter || seen.has(filter)) continue;
    seen.add(filter);
    rules.push({
      id: RULE_ID_BASE + rules.length,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ]
      },
      condition: { urlFilter: filter, resourceTypes: ['sub_frame'] }
    });
  }

  // Always clear the whole reserved id range instead of only the ids that were
  // present a moment ago, so a retry can never collide with a stale rule.
  const removeRuleIds = Array.from({ length: MAX_RULES }, (_, i) => RULE_ID_BASE + i);

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  console.log('[chat-panel] frame rules synced:', rules.length);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(['providers', 'selectedIndex']);
  const patch = {};
  if (!Array.isArray(stored.providers) || !stored.providers.length) patch.providers = DEFAULT_PROVIDERS;
  if (!Number.isInteger(stored.selectedIndex)) patch.selectedIndex = 2; // DeepSeek, like the BrowserOS default
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  await syncFrameRules();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Surface the built-in provider list once, right after install, so the panel
  // is usable without the user having to discover the gear icon.
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html?view=settings') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncFrameRules();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Any settings change must be reflected in the header rules.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.providers) syncFrameRules();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'openPopup') {
        await chrome.windows.create({
          url: msg.url,
          type: 'popup',
          width: 520,
          height: Math.min(900, Math.round((globalThis.screen?.availHeight ?? 900) * 0.9))
        });
        sendResponse({ ok: true });
      } else if (msg?.type === 'openTab') {
        await chrome.tabs.create({ url: msg.url });
        sendResponse({ ok: true });
      } else if (msg?.type === 'openCompare') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('compare.html') });
        sendResponse({ ok: true });
      } else if (msg?.type === 'resyncRules') {
        await syncFrameRules();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
