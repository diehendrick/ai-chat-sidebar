// Captures the README screenshots for v1.6.0: the result tray and the
// annotation editor (with a couple of annotations already drawn).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve('extension');
const DOCS = path.resolve('docs');
const PORT = 9345;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot16-'));

const SAMPLE = fs.readFileSync(path.join(DOCS, 'preview.png'));
const SAMPLE_DATA_URL = `data:image/png;base64,${SAMPLE.toString('base64')}`;

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--window-size=1300,900', '--disable-dev-shm-usage',
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

async function shot(cdp, sessionId, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return fs.statSync(file).size;
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

  // ---- 1. panel with result tray ----
  const panel = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  const pS = await cdp.send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 430, height: 820, deviceScaleFactor: 2, mobile: false }, pS.sessionId);
  await cdp.send('Page.enable', {}, pS.sessionId);
  await cdp.send('Runtime.enable', {}, pS.sessionId);
  await sleep(2500);
  await swEval(`chrome.runtime.sendMessage({type:'selftest', action:'trayDemo'}).catch(e => String(e))`);
  await sleep(900);
  const trayBytes = await shot(cdp, pS.sessionId, path.join(DOCS, 'result-tray.png'));

  // ---- 2. annotation editor with two annotations drawn ----
  await swEval(`chrome.storage.local.set({ 'annotate.pending': { dataUrl: ${JSON.stringify(SAMPLE_DATA_URL)}, label: 'Selected area' } })`);
  const ann = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/annotate.html` });
  const aS = await cdp.send('Target.attachToTarget', { targetId: ann.targetId, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 2, mobile: false }, aS.sessionId);
  await cdp.send('Page.enable', {}, aS.sessionId);
  await cdp.send('Runtime.enable', {}, aS.sessionId);
  await sleep(1800);

  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const c = document.getElementById('canvas');
      const r = c.getBoundingClientRect();
      const at = (x, y, type) => c.dispatchEvent(new PointerEvent(type, { clientX: r.left + x * r.width, clientY: r.top + y * r.height, bubbles: true, pointerId: 1 }));
      // rectangle around the header area
      document.querySelector('[data-tool="rect"]').click();
      document.querySelector('[data-color="#ff3b30"]').click();
      at(0.05, 0.06, 'pointerdown'); at(0.75, 0.06, 'pointermove'); at(0.75, 0.16, 'pointermove'); at(0.75, 0.16, 'pointerup');
      // arrow pointing at the menu
      document.querySelector('[data-tool="arrow"]').click();
      document.querySelector('[data-color="#34c759"]').click();
      at(0.62, 0.55, 'pointerdown'); at(0.80, 0.30, 'pointermove'); at(0.86, 0.22, 'pointermove'); at(0.86, 0.22, 'pointerup');
      return 'ok';
    })()`,
    returnByValue: true
  }, aS.sessionId);
  await sleep(600);
  const annBytes = await shot(cdp, aS.sessionId, path.join(DOCS, 'annotate-editor.png'));

  console.log(JSON.stringify({ ok: true, trayBytes, annBytes }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
