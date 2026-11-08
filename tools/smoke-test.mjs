// Smoke-test: load the unpacked extension in headless Chromium, verify the
// service worker registers, the side panel page renders, and DNR rules exist.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXT = path.resolve('extension');
const PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-prof-'));

const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`,
  `--remote-debugging-port=${PORT}`,
  '--enable-logging',
  `--log-file=${path.join(process.cwd(), 'work', 'chrome-smoke.log')}`,
  'about:blank'
], { stdio: 'ignore' });

// The DSH sandbox forbids piped stdio for child processes, so Chrome logs go to a file.
const logFile = path.join(process.cwd(), 'work', 'chrome-smoke.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(500);
  }
  throw new Error('devtools endpoint never came up');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { this.ws.close(); }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return new CDP(ws);
}

const report = { ok: false, checks: [] };
try {
  const version = await waitForDevtools();
  const cdp = await connect(version.webSocketDebuggerUrl);

  // 1. find the extension's service worker target
  let swTarget = null;
  for (let i = 0; i < 30 && !swTarget; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    // Branded Edge/Chrome also ship their own extension service workers, so
    // match ours precisely by its service-worker entry file name.
    swTarget = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && /\/background\.js$/.test(t.url)
    );
    if (!swTarget) await sleep(400);
  }
  report.checks.push({ name: 'service worker registered', pass: Boolean(swTarget), detail: swTarget?.url ?? 'not found' });
  if (!swTarget) throw new Error('extension service worker did not start');

  const extId = new URL(swTarget.url).host;
  report.extensionId = extId;

  // 2. attach to the SW and verify the DNR frame rules
  const sw = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
  const swEval = await cdp.send('Runtime.evaluate', {
    expression: `chrome.declarativeNetRequest.getDynamicRules().then(r => JSON.stringify({count: r.length, first: r[0]?.condition?.urlFilter}))`,
    awaitPromise: true,
    returnByValue: true
  }, sw.sessionId);
  report.checks.push({ name: 'DNR rules created', pass: /count":[1-9]/.test(swEval.result?.value ?? ''), detail: swEval.result?.value });

  // 3. open the side panel page as a tab and inspect it
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  const page = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, page.sessionId);
  await cdp.send('Page.enable', {}, page.sessionId);
  await sleep(2500);

  const dom = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      provider: document.getElementById('picker-label')?.textContent,
      frameSrc: document.getElementById('frame')?.getAttribute('src'),
      menuItems: document.querySelectorAll('#picker-menu li').length,
      hasSidePanelApi: typeof chrome.sidePanel === 'object',
      bodyText: document.body.innerText.slice(0, 120)
    })`,
    returnByValue: true
  }, page.sessionId);
  const data = JSON.parse(dom.result.value);
  report.checks.push({ name: 'panel renders provider', pass: data.provider === 'DeepSeek', detail: data.provider });
  report.checks.push({ name: 'iframe points at provider', pass: /^https:\/\//.test(data.frameSrc ?? ''), detail: data.frameSrc });
  report.checks.push({ name: 'provider menu populated', pass: data.menuItems === 5, detail: `${data.menuItems} items` });
  report.checks.push({ name: 'sidePanel API available', pass: data.hasSidePanelApi === true, detail: String(data.hasSidePanelApi) });
  report.panelState = data;

  report.ok = report.checks.every((c) => c.pass);
} catch (err) {
  report.error = String(err?.message ?? err);
} finally {
  const extErrors = readLog()
    .split('\n')
    .filter((l) => /extension|manifest|Failed to load|ERROR:/i.test(l))
    .slice(0, 25);
  report.stderrHighlights = extErrors;
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
