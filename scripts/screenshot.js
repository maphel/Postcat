// Renders docs/screenshot.png: the panel with a few captured requests and one replayed response.
// Uses the same harness as test/e2e.js (stubbed chrome.devtools) in Playwright's Chromium.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { buildExtension, launch, openPanel, harEntry } from '../test/harness.js';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'docs', 'screenshot.png');

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 42, name: 'Mittens', tags: ['cat', 'indoor'], owner: { email: 'mia@example.test', verified: true }, adoptedAt: null }));
});

await new Promise((r) => server.listen(8766, r));
const { dir, cleanup } = buildExtension();
const { ctx, id } = await launch(dir);
try {
  const { page } = await openPanel(ctx, id, { width: 1280, height: 560 });
  await page.evaluate(() => {
    const call = (method, url, status, time, body) => harEntry({
      method, url, status, time, body,
      statusText: status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'OK',
      headers: [{ name: 'accept', value: 'application/json' }, { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' }],
      resHeaders: [{ name: 'content-type', value: 'application/json' }],
      content: '{"id":42,"name":"Mittens"}',
    });
    __emit(call('DELETE', 'http://localhost:8766/api/cats/7', 404, 51));
    __emit(call('PATCH', 'http://localhost:8766/api/cats/42', 200, 96, '{"name":"Mittens"}'));
    __emit(call('POST', 'http://localhost:8766/api/cats', 201, 142, '{"name":"Mittens","tags":["cat","indoor"]}'));
    __emit(call('GET', 'http://localhost:8766/api/cats?page=1&limit=20', 200, 83));
  });
  // The list renders on the next animation frame.
  await page.waitForFunction(() => document.querySelectorAll('#requestList li[data-id]').length === 4);
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
  cleanup();
}
