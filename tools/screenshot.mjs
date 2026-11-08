// Capture a screenshot of the replica side panel (settings drawer open, so the
// provider list is visible) for documentation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER = process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EXT = path.resolve('extension');
const OUT = path.resolve('docs/preview.png');
const PORT = 9336;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-prof-'));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  '--disable-dev-shm-usage', '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--user-data-dir=${profile}`, `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`, 'about:blank'
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

  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  const pg = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 760, deviceScaleFactor: 2, mobile: false }, pg.sessionId);
  await cdp.send('Page.enable', {}, pg.sessionId);
  await cdp.send('Runtime.enable', {}, pg.sessionId);
  await sleep(2500);

  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('btn-menu').click(); 'ok'`,
    returnByValue: true
  }, pg.sessionId);
  await sleep(700);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, pg.sessionId);
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
} catch (e) {
  console.error('screenshot failed:', e.message);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
