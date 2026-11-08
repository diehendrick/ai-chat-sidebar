// Renders a tall, clearly sectioned page and saves the stitched full-page
// capture so the stitch can be inspected visually (repetition would show up as
// repeated SECTION labels).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve('extension');
const OUT = path.resolve('docs/fullpage-sample.png');
const PORT = 9342;

const sections = Array.from({ length: 7 }, (_, i) => `
  <section style="height:760px;background:${['#e8f0ff', '#ffe8e8', '#e8ffe9', '#fff6e0', '#f0e8ff', '#e0fbff', '#f5f5f5'][i]}">
    <h2 style="margin:0;padding:40px;font:700 64px/1 system-ui">SECTION ${i + 1}</h2>
    <p style="padding:0 40px;font:20px/1.6 system-ui">Unique content for section ${i + 1}, so duplicates are obvious.</p>
  </section>`).join('');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Tall page</title></head>
<body style="margin:0">${sections}</body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE_URL = `http://127.0.0.1:${server.address().port}/tall`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-prof-'));
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=900,800', '--disable-dev-shm-usage',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
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

  const page = await cdp.send('Target.createTarget', { url: PAGE_URL });
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(1200);
  await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  await sleep(1200);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(400);

  await swEval(`chrome.storage.local.remove('selftest')`);
  await swEval(`chrome.runtime.sendMessage({type:'selftest', action:'shotFullSave'}).catch(e => String(e))`);

  let result = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const raw = await swEval(`chrome.storage.local.get('selftest').then(o => JSON.stringify(o.selftest ?? null))`);
    result = JSON.parse(raw);
    if (result && result.action === 'shotFullSave') break;
  }
  if (!result?.b64) throw new Error('no image produced');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(result.b64, 'base64'));
  console.log(JSON.stringify({ ok: true, bytes: result.bytes, file: OUT }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
