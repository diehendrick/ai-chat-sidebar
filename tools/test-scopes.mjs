// Verifies the v1.4.0 scope options against a controlled local page:
//   copy: content-only vs whole page (must differ, and content must drop chrome)
//   screenshot: visible vs full page vs clipped region
//   toolbar: 3 frequent actions + overflow menu with the remaining entries
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve('extension');
const DEVTOOLS_PORT = 9341;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Test Article</title>
<style>
 body{margin:0;font:16px/1.6 system-ui}
 header{background:#eee;padding:20px} nav{background:#ddd;padding:20px}
 aside{float:right;width:180px;background:#eee;padding:16px;margin:12px}
 footer{background:#eee;padding:30px;margin-top:40px}
 article{max-width:640px;margin:0 auto;padding:24px}
</style></head><body>
<header>SITE HEADER — should be excluded</header>
<nav>NAVIGATION MENU — should be excluded</nav>
<aside>SIDEBAR — should be excluded</aside>
<article>
  <h1>Real article title</h1>
  <p>ARTICLE BODY PARAGRAPH ONE. This is the actual content that matters when copying a page into a chat.</p>
  <p>ARTICLE BODY PARAGRAPH TWO. It continues with more text so the semantic container passes the length threshold.</p>
  <p>ARTICLE BODY PARAGRAPH THREE. Padding to make the article clearly longer than two hundred characters in total.</p>
</article>
<footer>SITE FOOTER — should be excluded</footer>
<div style="height:1600px">tall spacer for full-page capture</div>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const PAGE_URL = `http://127.0.0.1:${PORT}/article`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'act-prof-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1000,800', '--disable-dev-shm-usage',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DEVTOOLS_PORT}`, 'about:blank'
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
    try { const r = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
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

  // the article page is the active tab the actions must target
  const page = await cdp.send('Target.createTarget', { url: PAGE_URL });
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(1500);

  // panel runs in the background
  await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  await sleep(1200);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(500);

  async function selftest(action, timeoutMs = 30000) {
    await swEval(`chrome.storage.local.remove('selftest')`);
    await swEval(`chrome.runtime.sendMessage({type:'selftest', action: ${JSON.stringify(action)}}).catch(e => String(e))`);
    for (let i = 0; i < timeoutMs / 500; i++) {
      await sleep(500);
      const raw = await swEval(`chrome.storage.local.get('selftest').then(o => JSON.stringify(o.selftest ?? null))`);
      const val = JSON.parse(raw);
      if (val && val.action === action) return val;
    }
    return null;
  }

  const content = await selftest('copyContent');
  const whole = await selftest('copyWhole');

  check('content-only copy works', Boolean(content?.ok) && content.chars > 0, JSON.stringify(content));
  check('whole-page copy works', Boolean(whole?.ok) && whole.chars > 0, JSON.stringify(whole));
  check('content is smaller than whole page', content?.chars < whole?.chars, `${content?.chars} < ${whole?.chars}`);
  check('content keeps the article body', /ARTICLE BODY/.test(content?.sample ?? ''), content?.sample);
  check('content drops site chrome', !/SITE HEADER|SITE FOOTER|SIDEBAR/.test(content?.sample ?? ''), content?.sample);
  check('whole page keeps site chrome', /SITE HEADER/.test(whole?.sample ?? ''), whole?.sample);

  const shotVisible = await selftest('shotVisible');
  const shotFull = await selftest('shotFull');
  const shotClip = await selftest('shotClip');
  check('visible screenshot works', Boolean(shotVisible?.ok) && shotVisible.bytes > 0, JSON.stringify(shotVisible));
  check('full-page screenshot works', Boolean(shotFull?.ok) && shotFull.bytes > 0, JSON.stringify(shotFull));
  check('full page is bigger than viewport', (shotFull?.bytes ?? 0) > (shotVisible?.bytes ?? 0), `${shotFull?.bytes} > ${shotVisible?.bytes}`);
  check('clipped region screenshot works', Boolean(shotClip?.ok) && shotClip.bytes > 0, JSON.stringify(shotClip));

  const overlay = await selftest('regionOverlay');
  check('area selection overlay appears', Boolean(overlay?.overlay), JSON.stringify(overlay));

  // toolbar + menu structure
  const panel = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  const panelS = await cdp.send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
  await sleep(1200);
  const ui = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      toolbar: [...document.querySelectorAll('.bar-actions > button.icon, .bar-actions .menu-wrap > button.icon')].map(b => b.id),
      actions: [...document.querySelectorAll('#menu [role=menuitem]')].map(i => i.dataset.action),
      labels: [...document.querySelectorAll('#menu [role=menuitem]')].map(i => i.textContent.trim()),
      hasCog: [...document.querySelectorAll('#menu [role=menuitem]')].some(i => i.dataset.action === 'settings')
    })`,
    returnByValue: true
  }, panelS.sessionId);
  const u = JSON.parse(ui.result.value);

  check('toolbar keeps only frequent actions + overflow', JSON.stringify(u.toolbar) === JSON.stringify(['btn-copy', 'btn-shot', 'btn-reset', 'btn-menu']), JSON.stringify(u.toolbar));
  check('menu exposes all 5 page actions', ['copy-content', 'copy-whole', 'shot-visible', 'shot-full', 'shot-region'].every((a) => u.actions.includes(a)), JSON.stringify(u.actions));
  check('settings lives in the overflow menu', u.hasCog === true, JSON.stringify(u.labels));

  const ok = checks.every((c) => c.pass);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e), checks }, null, 2));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  server.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
