// Regression test for the settings-drawer bug and the new compare view.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve('extension');
const PORT = 9337;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-prof-'));

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--remote-debugging-port=${PORT}`, 'about:blank'
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

  async function evalIn(url, expression, wait = 2500) {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const s = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, s.sessionId);
    await sleep(wait);
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s.sessionId);
    return r.result?.value;
  }

  const base = `chrome-extension://${extId}/sidepanel.html`;

  // 1. panel must NOT open with the settings drawer in front
  const initial = JSON.parse(await evalIn(base, `JSON.stringify({
    settingsVisible: !document.getElementById('settings').hidden,
    settingsDisplay: getComputedStyle(document.getElementById('settings')).display,
    provider: document.getElementById('picker-label').textContent,
    frame: document.getElementById('frame').getAttribute('src'),
    noteVisible: !document.getElementById('note').hidden
  })`));
  check('panel opens on the provider, not the settings drawer', initial.settingsVisible === false && initial.settingsDisplay === 'none', JSON.stringify(initial));
  check('default provider preloaded', initial.provider === 'DeepSeek' && /deepseek/.test(initial.frame ?? ''), initial.provider + ' -> ' + initial.frame);
  check('notice bar hidden by default', initial.noteVisible === false, String(initial.noteVisible));

  // 2. gear opens, Done closes (the reported bug)
  const toggled = JSON.parse(await evalIn(base, `(async () => {
    // settings now lives in the overflow menu (cog entry)
    document.getElementById('btn-menu').click();
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('[data-action="settings"]').click();
    await new Promise(r => setTimeout(r, 200));
    const opened = !document.getElementById('settings').hidden;
    document.getElementById('settings-close').click();
    await new Promise(r => setTimeout(r, 200));
    const closed = document.getElementById('settings').hidden;
    return JSON.stringify({ opened, closed,
      pickButtons: document.querySelectorAll('.provider-row .pick').length,
      activePicks: document.querySelectorAll('.provider-row .pick.is-active').length });
  })()`));
  check('overflow menu opens settings', toggled.opened === true, String(toggled.opened));
  check('Done closes settings (bug fixed)', toggled.closed === true, String(toggled.closed));
  check('provider selector available inside settings', toggled.pickButtons === 5 && toggled.activePicks === 1, `picks=${toggled.pickButtons} active=${toggled.activePicks}`);

  // 3. compare view (Clash of GPTs)
  const compare = JSON.parse(await evalIn(`chrome-extension://${extId}/compare.html`, `JSON.stringify({
    chips: document.querySelectorAll('.chip').length,
    panes: document.querySelectorAll('.pane').length,
    frames: [...document.querySelectorAll('.pane iframe')].map(f => f.getAttribute('src'))
  })`, 3000));
  check('compare view renders panes', compare.chips === 5 && compare.panes === 4, `chips=${compare.chips} panes=${compare.panes}`);
  check('each pane targets a provider', compare.frames.every((s) => /^https:\/\//.test(s ?? '')), JSON.stringify(compare.frames));

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
