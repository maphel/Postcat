import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';
import { chromium } from 'playwright';

// Copy the extension to a temp dir and add a harness page that loads the panel with a fake chrome.devtools.
const root = path.join(import.meta.dirname, '..');
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'postcat-e2e-'));
fs.copyFileSync(path.join(root, 'manifest.json'), path.join(ext, 'manifest.json'));
fs.cpSync(path.join(root, 'src'), path.join(ext, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'icons'), path.join(ext, 'icons'), { recursive: true });
fs.copyFileSync(path.join(import.meta.dirname, 'devtools-stub.js'), path.join(ext, 'src', 'stub.js'));
fs.writeFileSync(path.join(ext, 'src', 'harness.html'), fs.readFileSync(path.join(root, 'src', 'panel.html'), 'utf8')
  .replace('<script type="module" src="panel/main.js"></script>', '<script src="stub.js"></script><script type="module" src="panel/main.js"></script>'));

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MEDIA = {
  '/media/img.png': ['image/png', Buffer.from(PNG_1x1, 'base64')],
  '/media/octet': ['application/octet-stream', Buffer.from(PNG_1x1, 'base64')],
  '/media/page.html': ['text/html; charset=utf-8', Buffer.from('<h1>Hello page</h1>')],
  '/media/blob.bin': ['application/octet-stream', Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0x50, 0x43])],
};

const server = http.createServer((req, res) => {
  if (req.url === '/huge') {
    // 55 MB, above the worker's 50 MB cap.
    res.setHeader('content-type', 'application/octet-stream');
    const chunk = Buffer.alloc(1024 * 1024);
    let n = 0;
    const write = () => { while (n < 55) { n++; if (!res.write(chunk)) return res.once('drain', write); } res.end(); };
    return write();
  }
  if (req.url === '/redirect-sub') { res.writeHead(302, { location: 'http://a.localhost:8765/echo' }); return res.end(); }
  if (req.url === '/redirect-same') { res.writeHead(302, { location: 'http://localhost:8765/echo' }); return res.end(); }
  if (req.url === '/big') {
    res.setHeader('content-type', 'application/json');
    return res.end('{"id":12345678901234567890,"price":1.10}');
  }
  if (req.url === '/slow') {
    setTimeout(() => res.end('finally'), 5000);
    return;
  }
  if (MEDIA[req.url]) {
    res.setHeader('content-type', MEDIA[req.url][0]);
    return res.end(MEDIA[req.url][1]);
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'leak=1');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  });
});

(async () => {
  await new Promise((r) => server.listen(8765, r));
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: process.env.CHROME || undefined,
    // Playwright's default headless build ("headless shell") can't load extensions; "chromium" is the full browser.
    channel: process.env.CHROME ? undefined : 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--headless=new'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];

  const PNG = PNG_1x1;
  // 1) Background send: forbidden headers via DNR, origin removed, body, cookies isolated.
  const r = await sw.evaluate(() => postcatSend({
    method: 'POST', url: 'http://localhost:8765/api?x=1',
    headers: [
      { name: ':authority', value: 'x' }, { name: 'Cookie', value: 'session=abc' },
      { name: 'User-Agent', value: 'Postcat-Test' }, { name: 'Referer', value: 'https://ref.test/' },
      { name: 'X-Custom', value: 'yes' }, { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Length', value: '999' },
    ],
    body: '{"a":1}',
  }));
  const echo = JSON.parse(r.body);
  console.log('status', r.status, 'size', r.size);
  console.log('echo headers', JSON.stringify(echo.headers));
  const checks = {
    cookie: echo.headers.cookie === 'session=abc',
    ua: echo.headers['user-agent'] === 'Postcat-Test',
    referer: echo.headers.referer === 'https://ref.test/',
    custom: echo.headers['x-custom'] === 'yes',
    noOrigin: !('origin' in echo.headers),
    body: echo.body === '{"a":1}' && echo.method === 'POST',
  };
  // Sprint 2: merged duplicate cookies, credentials in the URL, non-http schemes, Accept-Encoding.
  const sprint2 = await sw.evaluate(async () => {
    const get = (url, headers = []) => postcatSend({ method: 'GET', url, headers, body: '' }).then((r) => JSON.parse(r.body).headers, (e) => ({ thrown: String(e.message) }));
    return {
      dup: await get('http://localhost:8765/dup', [{ name: 'Cookie', value: 'a=1' }, { name: 'Cookie', value: 'b=2' }]),
      auth: await get('http://user:p%40ss@localhost:8765/auth'),
      file: await get('file:///etc/hosts'),
      enc: await get('http://localhost:8765/enc', [{ name: 'Accept-Encoding', value: 'identity' }]),
    };
  });
  checks.mergedCookies = sprint2.dup.cookie === 'a=1; b=2';
  checks.urlCredentials = sprint2.auth.authorization === `Basic ${btoa('user:p@ss')}`;
  checks.httpOnly = /^Only http\(s\) URLs/.test(sprint2.file.thrown);
  checks.acceptEncoding = sprint2.enc['accept-encoding'] === 'identity';
  // Security review: body cap, and header rules scoped to the exact origin.
  const guard = await sw.evaluate(async () => {
    const cookie = [{ name: 'Cookie', value: 's=1' }];
    const huge = await postcatSend({ method: 'GET', url: 'http://localhost:8765/huge', headers: [], body: '' });
    const sub = await postcatSend({ method: 'GET', url: 'http://localhost:8765/redirect-sub', headers: cookie, body: '' });
    const same = await postcatSend({ method: 'GET', url: 'http://localhost:8765/redirect-same', headers: cookie, body: '' });
    return { huge: { tooLarge: huge.tooLarge, size: huge.size, body: huge.body, b64: huge.bodyBase64 },
      sub: JSON.parse(sub.body).headers.cookie, same: JSON.parse(same.body).headers.cookie };
  });
  checks.bodyCap = guard.huge.tooLarge === true && guard.huge.body === null && guard.huge.b64 === null;
  checks.subdomainRedirectNoCookie = guard.sub === undefined;
  checks.sameOriginRedirectKeepsCookie = guard.same === 's=1';
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  checks.rulesCleaned = rules.length === 0;
  // A second send without Cookie must not carry the old one or the Set-Cookie from the response.
  const r2 = await sw.evaluate(() => postcatSend({ method: 'GET', url: 'http://localhost:8765/b', headers: [], body: 'ignored' }));
  checks.noCookieLeak = !('cookie' in JSON.parse(r2.body).headers);
  console.log('SW checks', checks);
  for (const [k, ok] of Object.entries(checks)) assert.ok(ok, `SW check failed: ${k}`);

  // 2) Panel UI via harness with fake devtools API.
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1300, height: 600 });
  await page.goto(`chrome-extension://${id}/src/harness.html`);
  await page.evaluate(() => {
    const mk = (method, url, type, status, reqBody) => ({
      startedDateTime: new Date().toISOString() + Math.random(), time: 42, _resourceType: type,
      request: { method, url, headers: [{ name: ':method', value: method }, { name: 'accept', value: 'application/json' }, { name: 'cookie', value: 'sid=1' }], postData: reqBody ? { text: reqBody } : undefined },
      response: { status, statusText: 'OK', headers: [{ name: 'content-type', value: 'application/json' }], content: { size: 20, mimeType: 'application/json' } },
      getContent: (cb) => cb('{"recorded":true}', null),
    });
    __emit(mk('GET', 'http://localhost:8765/users?page=1', 'fetch', 200));
    __emit(mk('POST', 'http://localhost:8765/users', 'xhr', 201, '{"name":"cat"}'));
    __emit(mk('GET', 'http://localhost:8765/logo.png', 'image', 200));
  });
  // The list renders on the next animation frame; poll instead of sleeping.
  const listHas = (n) => page
    .waitForFunction((n) => document.querySelectorAll('#requestList li[data-id]').length === n, n, { timeout: 2000 })
    .then(() => true, () => false);
  const listCount = await listHas(2);
  await page.fill('#filterInput', '/POST/');
  const filtered = await listHas(1);
  await page.locator('#requestList li').first().click();
  const recordedBody = await page.textContent('#resBody');
  // Edit body and send
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"name":"edited"}');
  await page.click('#sendBtn');
  const sendDone = () => page.waitForFunction(() => !document.getElementById('sendBtn').disabled
    && /^\d/.test(document.getElementById('resStatus').textContent));
  await sendDone();
  const sent = JSON.parse(await page.textContent('#resBody'));
  const highlighted = await page.locator('#resBody .j-key').count();
  const editedMarker = await page.locator('#requestList li.selected .edited').count();
  const resetVisible = await page.isVisible('#resetBtn');
  const headerCount = await page.textContent('#reqHeaderCount');
  // Recorded vs. sent response toggle.
  await page.click('#resSource button[data-view=recorded]');
  const recordedAgain = await page.textContent('#resBody');
  await page.click('#resSource button[data-view=sent]');

  await page.click('#saveBtn');
  await page.waitForTimeout(100);
  const stored = await page.evaluate(() => chrome.storage.local.get('postcat.saved'));
  const saveHiddenForSaved = !(await page.isVisible('#saveBtn'));
  // Saved items autosave (debounced).
  await page.fill('#name', 'My call');
  await page.waitForTimeout(700);
  const autosaved = await page.evaluate(() => chrome.storage.local.get('postcat.saved'));

  // Keyboard navigation over the captured list, then reset the edited request.
  await page.click('#listTabs button[data-tab=captured]');
  await page.fill('#filterInput', '');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const navDown = await page.inputValue('#url');
  await page.keyboard.press('ArrowUp');
  const navUp = await page.inputValue('#url');
  await page.click('#resetBtn');
  await page.waitForTimeout(50);
  const bodyAfterReset = await page.inputValue('#body');
  const markerAfterReset = await page.locator('#requestList li .edited').count();

  // Params table edits the URL; headers table toggles lines.
  await page.keyboard.press('ArrowDown'); // -> GET /users?page=1
  await page.click('#reqTabs button[data-tab=params]');
  const paramCount = await page.textContent('#reqParamCount');
  await page.locator('#paramsView .kv-row').last().locator('.kv-key').fill('limit');
  await page.locator('#paramsView .kv-row').nth(1).locator('.kv-value').fill('5');
  const urlWithParam = await page.inputValue('#url');
  await page.click('#reqTabs button[data-tab=headers]');
  await page.locator('#headersView .kv-row').first().locator('input[type=checkbox]').uncheck();
  const headerCountAfterToggle = await page.textContent('#reqHeaderCount');

  // Pasting a cURL command outside inputs creates a saved request.
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', "curl 'http://localhost:8765/from-curl' -H 'x-from: curl' --data-raw 'hi'");
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  const curlUrl = await page.inputValue('#url');
  const curlMethod = await page.inputValue('#method');
  await page.click('#sendBtn');
  await sendDone();
  const curlEcho = JSON.parse(await page.textContent('#resBody'));

  // Delete with undo.
  const savedBefore = await page.locator('#requestList li[data-id]').count();
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Delete');
  const deleted = await listHas(savedBefore - 1);
  await page.click('#toastAction');
  const undone = await listHas(savedBefore);
  await page.waitForTimeout(400);
  const settings = (await page.evaluate(() => chrome.storage.local.get('postcat.settings')))['postcat.settings'];

  // Import log: bodies must survive a navigation of the inspected page, after which the real
  // DevTools getContent() returns nothing (verified against real Chrome).
  await page.evaluate(() => {
    window.__navigated = false;
    window.__har = [{
      startedDateTime: 'imported-1', time: 12, _resourceType: 'fetch',
      request: { method: 'GET', url: 'http://localhost:8765/imported', headers: [] },
      response: { status: 200, statusText: 'OK', headers: [], content: { size: 17, mimeType: 'application/json' } },
      getContent: (cb) => setTimeout(() => cb(window.__navigated ? null : '{"imported":true}', ''), 10),
    }];
  });
  await page.click('#importBtn');
  await page.waitForTimeout(50);
  await page.evaluate(() => { window.__navigated = true; });
  await page.fill('#filterInput', 'imported');
  await page.click('#listTabs button[data-tab=captured]');
  await listHas(1);
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#resTabs button[data-tab=resBody]');
  const importedBody = await page.textContent('#resBody');

  // ---------- media & binary responses ----------
  // Replay path: binary comes back as base64, text as text.
  const media = await sw.evaluate(async () => {
    const get = (url) => postcatSend({ method: 'GET', url: `http://localhost:8765${url}`, headers: [], body: '' });
    const [png, octet, html, bin] = await Promise.all(['/media/img.png', '/media/octet', '/media/page.html', '/media/blob.bin'].map(get));
    return { png, octet, html, bin };
  });
  const swMedia = media.png.body === null && media.png.bodyBase64 === PNG
    && media.octet.bodyBase64 != null && media.html.body === '<h1>Hello page</h1>' && media.bin.bodyBase64 != null;

  // Recorded path: DevTools hands out base64 for binary content.
  await page.evaluate((png) => {
    const mk = (path, mimeType, content, encoding) => ({
      startedDateTime: `media-${path}`, time: 5, _resourceType: 'fetch',
      request: { method: 'GET', url: `http://localhost:8765${path}`, headers: [] },
      response: { status: 200, statusText: 'OK', headers: [], content: { size: 70, mimeType } },
      getContent: (cb) => cb(content, encoding),
    });
    __emit(mk('/media/img.png', 'image/png', png, 'base64'));
    __emit(mk('/media/clip.mp4', 'video/mp4', btoa('\0\0\0\x20ftypisom not really a video'), 'base64'));
    __emit(mk('/media/blob.bin', 'application/octet-stream', btoa('\0\x01\x02\x03binary'), 'base64'));
    __emit(mk('/media/page.html', 'text/html', '<h1>Hello page</h1>', ''));
    const noCopy = mk('/media/nocopy', 'image/png', '', '');
    noCopy.response.headers = [{ name: 'content-length', value: '70' }];
    __emit(noCopy);
    const empty = mk('/media/empty', 'text/plain', '', '');
    empty.response.status = 204;
    __emit(empty);
    const failed = mk('/media/failed', '', '', '');
    failed.response.status = 0;
    failed.response._error = 'net::ERR_FAILED';
    __emit(failed);
    const redirect = mk('/media/redirect', '', '', '');
    redirect.response.status = 302;
    redirect.response.headers = [{ name: 'location', value: '/media/img.png' }];
    __emit(redirect);
  }, PNG);
  await page.click('#listTabs button[data-tab=captured]');
  await page.fill('#filterInput', '/media/');
  await listHas(8);
  const pick = async (path) => {
    await page.locator('#requestList li[data-id]', { hasText: path }).first().click();
    await page.click('#resTabs button[data-tab=resBody]');
  };
  const imgLoaded = () => page.waitForFunction(() => document.querySelector('#resPreview img')?.naturalWidth === 1, null, { timeout: 3000 }).then(() => true, () => false);

  await pick('/media/img.png');
  const recordedImage = await imgLoaded();
  const imageCaption = await page.textContent('#resPreview .caption');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), page.click('#saveResBtn')]);
  const savedName = download?.suggestedFilename();
  await page.click('#resMode button[data-mode=raw]');
  const imageHex = await page.textContent('#resBody');
  await page.click('#resMode button[data-mode=preview]');
  await page.click('#sendBtn');
  await sendDone().catch(() => {});
  const sentImage = await imgLoaded();

  await pick('/media/clip.mp4');
  const videoEl = await page.locator('#resPreview video').count();

  await pick('/media/blob.bin');
  const binHex = await page.textContent('#resBody');
  const copyHiddenForBinary = !(await page.isVisible('#copyResBtn'));

  await pick('/media/page.html');
  const htmlRaw = await page.textContent('#resBody');
  await page.click('#resMode button[data-mode=preview]');
  const htmlFrame = await page.locator('#resPreview iframe').getAttribute('srcdoc');
  const htmlSandbox = await page.locator('#resPreview iframe').getAttribute('sandbox');

  await pick('/media/nocopy');
  const noCopyNotice = await page.textContent('#resPreview .notice').catch(() => '');
  await pick('/media/empty');
  const emptyMessage = await page.textContent('#resBody');
  await pick('/media/failed');
  const failedNotice = await page.textContent('#resPreview .notice').catch(() => '');
  await pick('/media/redirect');
  const redirectMessage = await page.textContent('#resBody');
  // Multipart bodies get a warning in the body status line.
  await page.click('#newListBtn');
  await page.selectOption('#method', 'POST');
  await page.click('#reqTabs button[data-tab=headers]');
  await page.click('#bulkBtn');
  await page.fill('#headers', 'Content-Type: multipart/form-data; boundary=x');
  await page.click('#bulkBtn');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--');
  const multipartWarning = await page.textContent('#bodyStatus');
  await page.click('#listTabs button[data-tab=captured]');

  // ---------- polish round 3 ----------
  // Info line on captured requests.
  const infoLine = await page.textContent('#info');

  // Enter in the URL field sends.
  await page.click('#newListBtn');
  await page.fill('#url', 'http://localhost:8765/echo?x=1');
  await page.press('#url', 'Enter');
  await sendDone();
  const enterSent = JSON.parse(await page.textContent('#resBody')).url === '/echo?x=1';

  // Search through DevTools' search bar (devtools.js forwards to window.postcatSearch).
  // Expected count straight from the rendered text (case-insensitive, non-overlapping).
  const expectedMatches = await page.evaluate(() => document.getElementById('resBody').textContent.toLowerCase().split('e').length - 1);
  await page.evaluate(() => window.postcatSearch('performSearch', 'E'));
  const searchFirst = await page.textContent('#searchCount');
  const searchHighlights = await page.evaluate(() => CSS.highlights.get('postcat-match')?.size || 0);
  await page.evaluate(() => window.postcatSearch('nextSearchResult'));
  const searchSecond = await page.textContent('#searchCount');
  await page.evaluate(() => window.postcatSearch('performSearch', '"x-from'));  // no match in this body
  const searchNone = await page.textContent('#searchCount');
  await page.evaluate(() => window.postcatSearch('cancelSearch'));
  const searchHidden = !(await page.isVisible('#searchCount'));

  // JSON validation of the request body.
  await page.selectOption('#method', 'POST');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"a": 1,}');
  const badStatus = await page.textContent('#bodyStatus');
  const badMark = await page.getAttribute('#reqBodyMark', 'class');
  await page.fill('#body', '{"a": 1}');
  const goodStatus = await page.textContent('#bodyStatus');

  // Cancel a slow request.
  await page.fill('#url', 'http://localhost:8765/slow');
  await page.click('#sendBtn');
  const cancelLabel = await page.textContent('#sendBtn');
  const t0 = Date.now();
  await page.click('#sendBtn');
  await page.waitForFunction(() => document.getElementById('resBody').textContent === 'Request cancelled.', null, { timeout: 3000 }).catch(() => {});
  const cancelled = (await page.textContent('#resBody')) === 'Request cancelled.' && Date.now() - t0 < 3000;
  const sendLabelBack = await page.textContent('#sendBtn');

  // Readable network errors.
  await page.fill('#url', 'http://localhost:1/nothing');
  await page.click('#sendBtn');
  await sendDone().catch(() => {});
  await page.waitForFunction(() => /Couldn’t reach/.test(document.getElementById('resBody').textContent), null, { timeout: 5000 }).catch(() => {});
  const networkError = await page.textContent('#resBody');

  // ---------- bugfix sprint regressions ----------
  const setUrl = async (url) => { await page.fill('#url', url); };
  const newRequest = async (url) => { await page.click('#newListBtn'); await setUrl(url); };

  // Big integers survive response formatting and request-body beautify.
  await newRequest('http://localhost:8765/big');
  await page.click('#sendBtn');
  await sendDone();
  const bigResponse = await page.textContent('#resBody');
  await page.selectOption('#method', 'POST');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"id":12345678901234567890}');
  await page.click('#beautifyBtn');
  const bigBeautified = await page.inputValue('#body');

  // Editing one query param keeps the others byte-for-byte.
  await newRequest('http://localhost:8765/p?redirect=https%3A%2F%2Fx.com%2F&q=a+b&sig=abc');
  await page.click('#reqTabs button[data-tab=params]');
  await page.locator('#paramsView .kv-row').nth(2).locator('.kv-value').fill('xyz');
  const paramUrl = await page.inputValue('#url');

  // Deleting a request while it's sending, then Undo: not stuck on "Cancel", queue not blocked.
  await newRequest('http://localhost:8765/slow');
  await page.click('#sendBtn');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Delete');
  await page.click('#toastAction');
  const afterUndoLabel = await page.textContent('#sendBtn');
  const t1 = Date.now();
  await setUrl('http://localhost:8765/after-undo');
  await page.click('#sendBtn');
  await sendDone();
  const queueFree = Date.now() - t1 < 3000 && (await page.textContent('#resBody')).includes('/after-undo');

  // Identical requests in the same millisecond are two entries; Import adds only what's missing.
  await page.click('#listTabs button[data-tab=captured]');
  await page.fill('#filterInput', '/twin');
  await page.evaluate(() => {
    const mk = () => ({
      startedDateTime: 'twin-ms', time: 3, _resourceType: 'fetch',
      request: { method: 'GET', url: 'http://localhost:8765/twin', headers: [] },
      response: { status: 200, statusText: 'OK', headers: [], content: { size: 2, mimeType: 'application/json' } },
      getContent: (cb) => cb('{}', ''),
    });
    __emit(mk());
    __emit(mk());
    window.__har = [mk(), mk(), mk()];
  });
  const twinsLive = await listHas(2);
  await page.click('#importBtn');
  const twinsImported = await listHas(3);

  // Clear + Undo keeps sent responses; Import after Clear doesn't bring cleared requests back.
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#sendBtn');
  await sendDone();
  await page.click('#clearBtn');
  await page.click('#importBtn');
  const nothingReimported = await listHas(0);
  // The Import toast replaced Clear's Undo, so test Undo from a fresh capture.
  await page.evaluate(() => {
    __emit({
      startedDateTime: 'solo', time: 3, _resourceType: 'fetch',
      request: { method: 'GET', url: 'http://localhost:8765/twin-solo', headers: [] },
      response: { status: 299, statusText: 'Recorded', headers: [], content: { size: 2, mimeType: 'application/json' } },
      getContent: (cb) => cb('{}', ''),
    });
  });
  await listHas(1);
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#sendBtn');
  await sendDone();
  await page.click('#clearBtn');
  await page.click('#toastAction');
  await listHas(1);
  const statusAfterUndo = await page.locator('#requestList li[data-id] .status').first().textContent();

  // The 1000-entry cap never drops the request open in the editor.
  await page.fill('#filterInput', '');
  await page.evaluate(() => {
    for (let i = 0; i < 1000; i++) {
      __emit({
        startedDateTime: `bulk-${i}`, time: 1, _resourceType: 'fetch',
        request: { method: 'GET', url: `http://localhost:8765/bulk/${i}`, headers: [] },
        response: { status: 200, statusText: 'OK', headers: [], content: { size: 0, mimeType: '' } },
        getContent: (cb) => cb('', ''),
      });
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('#requestList li[data-id]').length === 1000, null, { timeout: 5000 }).catch(() => {});
  const selectedSurvives = await page.evaluate(() => JSON.stringify({
    kept: document.querySelector('#requestList li.selected') !== null,
    count: document.querySelectorAll('#requestList li[data-id]').length,
  }));

  // ---------- sprint 2: panel ----------
  // Holding Delete (key repeat) removes only one request.
  await page.click('#listTabs button[data-tab=captured]');
  await page.fill('#filterInput', '/bulk/');
  await listHas(999);
  await page.locator('#requestList li[data-id]').first().click();
  await page.evaluate(() => {
    document.activeElement.blur();
    for (let i = 0; i < 5; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', repeat: i > 0, bubbles: true }));
  });
  const removedByRepeat = (await listHas(998)) ? 1 : -1;

  // Typing in the editor must not scroll the list back to the selected row.
  await page.locator('#requestList li[data-id]').first().click();
  await page.waitForTimeout(100); // let the selection render (rAF) before scrolling away
  await page.evaluate(() => { document.getElementById('requestList').scrollTop = 4000; });
  const scrollBefore = await page.evaluate(() => document.getElementById('requestList').scrollTop);
  await page.type('#url', 'x');
  await page.waitForTimeout(80);
  const scrollAfter = await page.evaluate(() => document.getElementById('requestList').scrollTop);

  // Corrupt saved records and invalid layout in storage must not break the panel.
  await page.evaluate(() => chrome.storage.local.set({
    'postcat.saved': [{ name: 'ok', method: 'get', url: 'http://a.test', headersText: '', body: '' }, { url: 'http://no-method.test' }, null, 'junk'],
    'postcat.settings': { layout: { sidebarW: null, reqW: 'wide' }, tab: 'saved', reqTab: 'nope' },
  }));
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#requestList li[data-id]').length === 2, null, { timeout: 3000 }).catch(() => {});
  const afterReload = await page.evaluate(() => ({
    saved: [...document.querySelectorAll('#requestList li[data-id]')].map((li) => li.title.split('\n')[0]),
    columns: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
    sidebarW: document.documentElement.style.getPropertyValue('--sidebar-w'),
  }));

  const ui = {

    listCount, filtered,
    recordedBody: recordedBody.includes('"recorded": true'),
    sentBody: sent.body === '{"name":"edited"}', sentCookie: sent.headers.cookie === 'sid=1',
    highlighted: highlighted > 0,
    recordedToggle: recordedAgain.includes('"recorded": true'),
    saved: stored['postcat.saved']?.length === 1,
    editedMarker: editedMarker === 1, resetVisible, headerCount: headerCount === '2',
    saveHiddenForSaved, autosave: autosaved['postcat.saved']?.[0]?.name === 'My call',
    navDown: navDown.endsWith('/users?page=1'), navUp: navUp.endsWith('/users'),
    reset: bodyAfterReset === '{"name":"cat"}' && markerAfterReset === 0,
    paramCount: paramCount === '1', paramsEditUrl: urlWithParam.endsWith('/users?page=1&limit=5'),
    headerToggle: headerCountAfterToggle === '1',
    curlImport: curlUrl.endsWith('/from-curl') && curlMethod === 'POST',
    curlSend: curlEcho.headers['x-from'] === 'curl' && curlEcho.body === 'hi',
    deleteUndo: savedBefore === 2 && deleted && undone,
    settingsPersisted: settings?.reqTab === 'headers' && settings?.tab === 'saved',
    importBodyAfterNavigation: importedBody.includes('"imported": true'),
    swMedia,
    recordedImage, imageCaption: imageCaption.startsWith('1 × 1 · image/png'),
    saveDownload: savedName === 'img.png',
    imageRawHex: imageHex.includes('|.PNG'),
    sentImage,
    videoPreview: videoEl === 1,
    binaryHex: binHex.startsWith('application/octet-stream') && binHex.includes('00 01 02 03'),
    copyHiddenForBinary,
    htmlRawDefault: htmlRaw === '<h1>Hello page</h1>',
    htmlPreview: htmlFrame?.includes('<h1>Hello page</h1>') && htmlSandbox === '',
    noCopyNotice: noCopyNotice.includes('kept no copy'),
    infoLine: /^Captured( [^·]+)? · fetch · 5 ms$/.test(infoLine),
    enterSent,
    search: expectedMatches > 5 && searchFirst === `1 / ${expectedMatches}` && searchHighlights === expectedMatches
      && searchSecond === `2 / ${expectedMatches}` && searchNone === 'No matches' && searchHidden,
    jsonStatus: badStatus.includes('line 1, column 9') && badMark.includes('bad') && goodStatus === '✓ Valid JSON',
    cancel: cancelLabel === 'Cancel' && cancelled && sendLabelBack === 'Send',
    networkError: networkError.startsWith('Couldn’t reach localhost:1.'),
    bigIntResponse: bigResponse.includes('12345678901234567890') && bigResponse.includes('1.10'),
    bigIntBeautify: bigBeautified === '{\n  "id": 12345678901234567890\n}',
    paramsRawKept: paramUrl === 'http://localhost:8765/p?redirect=https%3A%2F%2Fx.com%2F&q=a+b&sig=xyz',
    deleteUndoNotStuck: afterUndoLabel === 'Send' && queueFree,
    identicalRequests: twinsLive && twinsImported,
    clearThenImport: nothingReimported,
    clearUndoKeepsSent: statusAfterUndo === '200',
    capKeepsSelected: JSON.parse(selectedSurvives).kept && JSON.parse(selectedSurvives).count === 1000,
    keyRepeatDeletesOne: removedByRepeat === 1,
    noScrollOnTyping: scrollBefore > 0 && scrollAfter === scrollBefore,
    corruptStorage: afterReload.saved.join(',') === 'GET http://a.test,GET http://no-method.test'
      && /^\d+(\.\d+)?px \d+(\.\d+)?px \d+(\.\d+)?px$/.test(afterReload.columns) && afterReload.sidebarW === '320px',
    emptyBody: emptyMessage === 'Empty response body.',
    failedNotice: failedNotice.includes('net::ERR_FAILED'),
    redirectMessage: redirectMessage === 'Redirect → /media/img.png',
    multipartWarning: multipartWarning.startsWith('⚠ Multipart'),
  };
  console.log('UI checks', ui);
  for (const [k, ok] of Object.entries(ui)) assert.ok(ok, `UI check failed: ${k}`);
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  assert.deepStrictEqual(errors, [], 'panel threw errors');
  await ctx.close();
  fs.rmSync(ext, { recursive: true, force: true });
  console.log('e2e ok');
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
