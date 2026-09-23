// Renders docs/screenshot.png: the panel with a few captured requests and one replayed response.
// Uses the same harness as test/e2e.js (stubbed chrome.devtools) in Playwright's Chromium.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'docs', 'screenshot.png');

const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'postcat-shot-'));
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(ext, 'manifest.json'));
fs.cpSync(path.join(root, 'src'), path.join(ext, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'icons'), path.join(ext, 'icons'), { recursive: true });
fs.copyFileSync(path.join(root, 'test', 'devtools-stub.js'), path.join(ext, 'src', 'stub.js'));
fs.writeFileSync(path.join(ext, 'src', 'harness.html'), fs.readFileSync(path.join(root, 'src', 'panel.html'), 'utf8')
  .replace('<script type="module" src="panel/main.js"></script>', '<script src="stub.js"></script><script type="module" src="panel/main.js"></script>'));

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 42, name: 'Mittens', tags: ['cat', 'indoor'], owner: { email: 'mia@example.test', verified: true }, adoptedAt: null }));
});

const entry = (method, url, status, time, body) => ({
  startedDateTime: new Date().toISOString(), time, _resourceType: 'fetch',
  request: { method, url, headers: [{ name: 'accept', value: 'application/json' }, { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' }], postData: body ? { text: body } : undefined },
  response: { status, statusText: status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'OK', headers: [{ name: 'content-type', value: 'application/json' }], content: { size: 120, mimeType: 'application/json' } },
  getContent: (cb) => cb('{"id":42,"name":"Mittens"}', ''),
});

await new Promise((r) => server.listen(8766, r));
const ctx = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROME || undefined,
  channel: process.env.CHROME ? undefined : 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
});
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto(`chrome-extension://${sw.url().split('/')[2]}/src/harness.html`);
  await page.evaluate((mk) => {
    const e = new Function(`return ${mk}`)();
    __emit(e('DELETE', 'http://localhost:8766/api/cats/7', 404, 51));
    __emit(e('PATCH', 'http://localhost:8766/api/cats/42', 200, 96, '{"name":"Mittens"}'));
    __emit(e('POST', 'http://localhost:8766/api/cats', 201, 142, '{"name":"Mittens","tags":["cat","indoor"]}'));
    __emit(e('GET', 'http://localhost:8766/api/cats?page=1&limit=20', 200, 83));
  }, entry.toString());
  await page.waitForTimeout(150);
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#reqTabs button[data-tab=headers]');
  await page.click('#sendBtn');
  await page.waitForFunction(() => !document.getElementById('sendBtn').disabled && /^\d/.test(document.getElementById('resStatus').textContent));
  await page.mouse.move(0, 0);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(path.relative(root, out));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
}
