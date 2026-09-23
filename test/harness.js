// Shared setup for test/e2e.js and scripts/screenshot.js: a throwaway copy of the extension whose
// harness page runs the panel under the stubbed chrome.devtools (test/devtools-stub.js), a Playwright
// launch that can load extensions, a factory for the fake HAR entries the stub feeds the panel, and
// the waits both scripts need (list rendered, send finished).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const root = path.join(import.meta.dirname, '..');

// Copies manifest.json, src/ and icons/ to a temp dir, adds the devtools stub as src/stub.js and
// writes src/harness.html: panel.html with the stub loaded before the panel's entry point.
export function buildExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postcat-harness-'));
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'icons'), path.join(dir, 'icons'), { recursive: true });
  fs.copyFileSync(path.join(root, 'test', 'devtools-stub.js'), path.join(dir, 'src', 'stub.js'));
  fs.writeFileSync(path.join(dir, 'src', 'harness.html'), fs.readFileSync(path.join(root, 'src', 'panel.html'), 'utf8')
    .replace('<script type="module" src="panel/main.js"></script>', '<script src="stub.js"></script><script type="module" src="panel/main.js"></script>'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Launches Chromium with the extension from `dir` and waits for its service worker.
// Returns the context, the worker and the extension id.
export async function launch(dir) {
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: process.env.CHROME || undefined,
    // Playwright's default headless build ("headless shell") can't load extensions; "chromium" is the full browser.
    channel: process.env.CHROME ? undefined : 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--headless=new'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return { ctx, sw, id: sw.url().split('/')[2] };
}

// Opens the harness page in a new tab and collects its uncaught errors. `harEntry` is installed as a
// page global before the panel boots, so page.evaluate() callbacks can call it under the same name
// as the import and hand the result to __emit().
export async function openPanel(ctx, id, { width, height }) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width, height });
  await page.addInitScript(`window.harEntry = ${harEntry};`);
  await page.goto(`chrome-extension://${id}/src/harness.html`);
  return { page, errors };
}

// The list renders on the next animation frame (list.js): resolves once it shows exactly `n` rows.
// Rejects after `timeout` ms (Playwright's default when omitted).
export function waitForRows(page, n, timeout) {
  return page.waitForFunction((n) => document.querySelectorAll('#requestList li[data-id]').length === n, n, { timeout });
}

// Resolves once a send has finished: the Send button is enabled again and the status line shows a code.
export function waitForSendDone(page) {
  return page.waitForFunction(() => !document.getElementById('sendBtn').disabled
    && /^\d/.test(document.getElementById('resStatus').textContent));
}

// A fake chrome.devtools.network HAR entry. Every field has a plain default so a test names only what
// it is about. Self-contained on purpose (no outer references): openPanel() installs its source in
// the page, where getContent() must stay a real function for the panel to call.
export function harEntry(o = {}) {
  const content = o.content ?? '';
  return {
    startedDateTime: o.started ?? new Date().toISOString(),
    time: o.time ?? 1,
    _resourceType: o.type ?? 'fetch',
    request: {
      method: o.method ?? 'GET', url: o.url, headers: o.headers ?? [],
      postData: o.body ? { text: o.body } : undefined,
    },
    response: {
      status: o.status ?? 200, statusText: o.statusText ?? 'OK', headers: o.resHeaders ?? [],
      content: { size: content.length, mimeType: o.mime ?? 'application/json' },
      ...(o.error ? { _error: o.error } : {}),
    },
    getContent: (cb) => cb(content, o.encoding ?? ''),
  };
}
