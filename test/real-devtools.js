// Runs Postcat inside a real Chrome with real DevTools (no API stubs).
// Opens DevTools, shows the Postcat panel via the DevTools frontend, and drives it over CDP.
// Chrome is driven over raw CDP with no Playwright page handle, so there is nothing like
// waitForFunction here: targets are polled (waitForTarget) because their appearance is observable
// from /json/list, while everything else (network round trips, DevTools forwarding, panel renders)
// waits a fixed sleep() sized generously above the expected latency.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { chromium } from 'playwright';

// The full Chromium (not the headless shell): extensions and DevTools need it.
const CHROME = process.env.CHROME || chromium.executablePath('chromium');
const EXT = path.join(import.meta.dirname, '..');
const PORT = 8777;
const CDP_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeLog = []; // Chrome's stdout/stderr, printed when a target never shows up

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/img/cat.png')) {
    res.setHeader('content-type', 'image/png');
    return res.end(PNG_1x1);
  }
  if (req.url.startsWith('/?') || req.url === '/') {
    res.setHeader('content-type', 'text/html');
    return res.end('<h1>postcat test page</h1>');
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url }));
});

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const my = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== my) return;
      ws.removeEventListener('message', onMsg);
      if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description));
      else resolve(m.result?.result?.value);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const call = (method, params) => new Promise((resolve) => {
    const my = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== my) return;
      ws.removeEventListener('message', onMsg);
      resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  return { evaluate, call, close: () => ws.close() };
}

const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  } catch {
    return []; // Chrome is still starting
  }
};
async function waitForTarget(pred, label = 'target') {
  for (let i = 0; i < 150; i++) {
    const t = (await targets()).find(pred);
    if (t) return t;
    await sleep(200);
  }
  const seen = (await targets()).map((t) => `${t.type} ${t.url}`).join('\n  ') || '(none)';
  throw new Error(`${label} not found after 30 s; targets:\n  ${seen}\nchrome output:\n${chromeLog.join('')}`);
}

// Clicks every list item (re-querying, the list re-renders) and returns "METHOD url => body".
const READ_LIST = `(async () => {
  const q = () => document.querySelectorAll('#requestList li[data-id]');
  const out = [];
  for (let i = 0; i < q().length; i++) {
    q()[i].click();
    await new Promise((r) => setTimeout(r, 300));
    out.push(q()[i].title.split(String.fromCharCode(10))[0] + ' => ' + document.getElementById('resBody').textContent.replace(/\\s+/g, ''));
  }
  return out;
})()`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'postcat-real-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--auto-open-devtools-for-tabs', '--no-first-run', '--disable-gpu',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []), // CI containers
    `http://localhost:${PORT}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => chromeLog.push(String(d)));
  proc.stderr.on('data', (d) => chromeLog.push(String(d)));

  try {
    const devtoolsPage = await waitForTarget((t) => t.url.endsWith('/devtools.html'), 'devtools page');
    const extId = devtoolsPage.url.split('/')[2];
    const pageUrl = (t) => t.type === 'page' && t.url.startsWith(`http://localhost:${PORT}`);
    let page = await connect((await waitForTarget(pageUrl)).webSocketDebuggerUrl);
    await sleep(500);

    // Requests while DevTools is open but the Postcat panel was never shown -> only reachable via "Import log".
    await page.evaluate(`Promise.all([fetch('/api/one').then(r => r.text()), fetch('/api/two', { method: 'POST', body: '{"a":1}' }).then(r => r.text())])`);
    await sleep(300);

    const front = await connect((await waitForTarget((t) => t.url.startsWith('devtools://'))).webSocketDebuggerUrl);
    await front.evaluate(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      await UI.InspectorView.InspectorView.instance().showPanel('chrome-extension://${extId}Postcat');
    })()`);
    const panel = await connect((await waitForTarget((t) => t.url.endsWith('/panel.html'))).webSocketDebuggerUrl);
    await sleep(500);

    await panel.evaluate(`document.getElementById('importBtn').click()`);
    await sleep(300);

    // Navigating the inspected page invalidates DevTools request ids; bodies must already be kept.
    await page.evaluate(`location.href = '/?navigated'`);
    page.close();
    await sleep(1000);
    const imported = await panel.evaluate(READ_LIST);
    console.log('imported after navigation:', imported);
    assert.deepStrictEqual(imported.sort(), [
      'GET http://localhost:8777/api/one => {"path":"/api/one"}',
      'POST http://localhost:8777/api/two => {"path":"/api/two"}',
    ]);

    // Live recording, then another navigation.
    page = await connect((await waitForTarget(pageUrl)).webSocketDebuggerUrl);
    await page.evaluate(`fetch('/api/live').then(r => r.text())`);
    await sleep(500);
    await page.evaluate(`location.href = '/?again'`);
    page.close();
    await sleep(1000);
    const all = await panel.evaluate(READ_LIST);
    console.log('live after navigation:', all);
    assert.ok(all.includes('GET http://localhost:8777/api/live => {"path":"/api/live"}'));

    // Binary responses recorded by real DevTools (base64 from getContent) render as images.
    page = await connect((await waitForTarget(pageUrl)).webSocketDebuggerUrl);
    await page.evaluate(`fetch('/img/cat.png').then(r => r.arrayBuffer())`);
    await sleep(500);
    const waitImage = `(async () => {
      for (let i = 0; i < 30; i++) {
        const img = document.querySelector('#resPreview img');
        const caption = document.querySelector('#resPreview .caption')?.textContent;
        if (img && img.naturalWidth && caption) return caption;
        await new Promise((r) => setTimeout(r, 100));
      }
      return 'no image: ' + document.getElementById('resPreview').textContent + document.getElementById('resBody').textContent;
    })()`;
    await panel.evaluate(`document.querySelector('#requestList li[data-id]').click()`);
    const image = await panel.evaluate(waitImage);
    console.log('image preview:', image);
    assert.match(image, /^1 × 1 · image\/png/);

    // fetch().blob() leaves no copy in DevTools (Chrome limitation): offer to send again.
    await page.evaluate(`fetch('/img/cat.png?blob').then(r => r.blob())`);
    await sleep(500);
    await panel.evaluate(`document.querySelector('#requestList li[data-id]').click()`);
    await sleep(300);
    const notice = await panel.evaluate(`document.querySelector('#resPreview .notice')?.textContent || 'no notice'`);
    console.log('blob() notice:', notice);
    assert.match(notice, /kept no copy/);
    await panel.evaluate(`document.querySelector('#resPreview button').click()`);
    const resent = await panel.evaluate(waitImage);
    console.log('after send again:', resent);
    assert.match(resent, /^1 × 1 · image\/png/);
    page.close();

    // ⌘/Ctrl+F: DevTools opens its own search bar and forwards the query to the panel (devtools.js).
    await panel.evaluate(`[...document.querySelectorAll('#requestList li[data-id]')].find((li) => li.title.includes('/api/live')).click()`);
    await sleep(300);
    const mod = process.platform === 'darwin' ? 4 : 2; // Meta on macOS, Ctrl elsewhere
    const key = { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, modifiers: mod };
    await front.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await front.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await sleep(300);
    await front.call('Input.insertText', { text: 'live' });
    await sleep(600);
    const searchCount = await panel.evaluate(`document.getElementById('searchCount').hidden ? 'hidden' : document.getElementById('searchCount').textContent`);
    console.log('devtools search:', searchCount);
    assert.strictEqual(searchCount, '1 / 1');

    panel.close();
    front.close();
    console.log('real devtools ok');
  } finally {
    proc.kill();
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
