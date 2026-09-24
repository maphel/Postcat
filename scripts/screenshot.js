// Renders the README images into docs/: the compact panel at a bottom-docked size (1024 × 320,
// screenshot.png) and at a side-docked size (380 × 480, screenshot-side.png), each in the light and
// the dark appearance (-dark suffix). The scene is the same for all four: a few captured requests,
// one of them selected, its Headers tab open and one replayed JSON response. Uses the same harness
// as test/e2e.js (stubbed chrome.devtools) in Playwright's Chromium.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { buildExtension, launch, openPanel, harEntry, waitForRows, waitForSendDone } from '../test/harness.js';

const root = path.join(import.meta.dirname, '..');
const docs = path.join(root, 'docs');
const PORT = 8766;

const SIZES = [
  { name: 'screenshot', width: 1024, height: 320 },      // docked at the bottom: wide layout
  { name: 'screenshot-side', width: 380, height: 480 },  // docked to the side: narrow layout
];

const cat = {
  id: 42,
  name: 'Mittens',
  tags: ['cat', 'indoor'],
  owner: { email: 'mia@example.test', verified: true },
  weightKg: 4.2,
  adoptedAt: null,
};

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(cat));
});

// The captured requests, newest first in the list: the selected one (a PATCH with a JSON body)
// is emitted last so it sits at the top.
function emitScene(port) {
  const base = `http://localhost:${port}`;
  const call = (method, url, status, time, body) => harEntry({
    method, url: base + url, status, time, body,
    statusText: status === 201 ? 'Created' : status === 404 ? 'Not Found' : 'OK',
    headers: [
      { name: 'accept', value: 'application/json' },
      { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo' },
      ...(body ? [{ name: 'content-type', value: 'application/json' }] : []),
    ],
    resHeaders: [{ name: 'content-type', value: 'application/json' }],
    content: '{"id":42,"name":"Mittens"}',
  });
  __emit(call('GET', '/api/cats?page=1&limit=20', 200, 83));
  __emit(call('POST', '/api/cats', 201, 142, '{"name":"Mittens","tags":["cat","indoor"]}'));
  __emit(call('GET', '/api/cats/42/photos', 200, 61));
  __emit(call('DELETE', '/api/cats/7', 404, 51));
  __emit(call('PATCH', '/api/cats/42', 200, 96, '{"name":"Mittens","weightKg":4.2}'));
}

// Appearance through the panel's own control: the Options menu closes itself after the click.
// The Options button sits in the sidebar, which the narrow layout's detail screen hides: go back to
// the list for the click and reopen the row afterwards (the selection and the Response view stay).
async function setAppearance(page, value) {
  const onDetail = await page.evaluate(() => {
    const app = document.getElementById('app');
    return app.dataset.layout === 'narrow' && app.dataset.screen === 'detail';
  });
  if (onDetail) await page.click('#backBtn');
  await page.click('#captureBtn');
  await page.click(`#appearance button[data-appearance=${value}]`);
  await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, value === 'dark');
  if (onDetail) await page.locator('#requestList li.selected').click();
}

async function shoot(page, file) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(0, 0);
  const out = path.join(docs, file);
  await page.screenshot({ path: out });
  console.log(`${path.relative(root, out)}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}

await new Promise((r) => server.listen(PORT, r));
const { dir, cleanup } = buildExtension();
const { ctx, id } = await launch(dir);
try {
  fs.mkdirSync(docs, { recursive: true });
  for (const { name, width, height } of SIZES) {
    const { page } = await openPanel(ctx, id, { width, height });
    await page.evaluate(emitScene, PORT);
    await waitForRows(page, 5);
    // Start light: the stubbed DevTools reports a dark theme, which 'system' would follow.
    await setAppearance(page, 'light');
    // A click opens the detail screen in the narrow layout; the send then reveals the response there.
    await page.locator('#requestList li[data-id]').first().click();
    await page.click('#reqTabs button[data-tab=headers]');
    await page.click('#sendBtn');
    await waitForSendDone(page);
    await shoot(page, `${name}.png`);
    await setAppearance(page, 'dark');
    await shoot(page, `${name}-dark.png`);
    await page.close();
  }
} finally {
  await ctx.close();
  server.close();
  cleanup();
}
