// End-to-end test: the service worker's replay path and the panel UI, driven by Playwright.
// The panel runs in the harness page (test/harness.js) under a stubbed chrome.devtools.
import http from 'node:http';
import assert from 'node:assert';
import { buildExtension, launch, openPanel, harEntry, waitForRows, waitForSendDone } from './harness.js';

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

// Assertions fail immediately, naming the check and showing actual vs. expected, so later steps
// (which build on this state) never run against a broken panel.
let passed = 0;
const pass = (name) => { passed++; console.log(`ok  ${name}`); };
function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  pass(name);
}
function match(name, actual, re) {
  assert.match(String(actual), re, `${name}: ${JSON.stringify(actual)} does not match ${re}`);
  pass(name);
}
function includes(name, actual, needle) {
  assert.ok(String(actual).includes(needle), `${name}: ${JSON.stringify(actual)} does not include ${JSON.stringify(needle)}`);
  pass(name);
}
function ok(name, condition, detail) {
  assert.ok(condition, `${name}: ${detail}`);
  pass(name);
}

(async () => {
  await new Promise((r) => server.listen(8765, r));
  const { dir, cleanup } = buildExtension();
  const { ctx, sw, id } = await launch(dir);

  // ---------- service worker: headers, cookies, redirects, body cap ----------
  // Forbidden headers go through DNR, Origin is removed, the body is kept, the cookie jar is untouched.
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
  check('Cookie header sent', echo.headers.cookie, 'session=abc');
  check('User-Agent overridden', echo.headers['user-agent'], 'Postcat-Test');
  check('Referer overridden', echo.headers.referer, 'https://ref.test/');
  check('custom header sent', echo.headers['x-custom'], 'yes');
  check('Origin removed', 'origin' in echo.headers, false);
  check('method and body', [echo.method, echo.body], ['POST', '{"a":1}']);

  // Merged duplicate cookies, credentials in the URL, non-http schemes, Accept-Encoding.
  const sent = await sw.evaluate(async () => {
    const get = (url, headers = []) => postcatSend({ method: 'GET', url, headers, body: '' }).then((r) => JSON.parse(r.body).headers, (e) => ({ thrown: String(e.message) }));
    return {
      dup: await get('http://localhost:8765/dup', [{ name: 'Cookie', value: 'a=1' }, { name: 'Cookie', value: 'b=2' }]),
      auth: await get('http://user:p%40ss@localhost:8765/auth'),
      file: await get('file:///etc/hosts'),
      enc: await get('http://localhost:8765/enc', [{ name: 'Accept-Encoding', value: 'identity' }]),
    };
  });
  check('duplicate Cookie headers merged', sent.dup.cookie, 'a=1; b=2');
  check('URL credentials become Authorization', sent.auth.authorization, `Basic ${btoa('user:p@ss')}`);
  match('non-http URL rejected', sent.file.thrown, /^Only http\(s\) URLs/);
  check('Accept-Encoding forwarded', sent.enc['accept-encoding'], 'identity');

  // Body cap, and header rules scoped to the exact origin.
  const guard = await sw.evaluate(async () => {
    const cookie = [{ name: 'Cookie', value: 's=1' }];
    const huge = await postcatSend({ method: 'GET', url: 'http://localhost:8765/huge', headers: [], body: '' });
    const sub = await postcatSend({ method: 'GET', url: 'http://localhost:8765/redirect-sub', headers: cookie, body: '' });
    const same = await postcatSend({ method: 'GET', url: 'http://localhost:8765/redirect-same', headers: cookie, body: '' });
    return { huge: { tooLarge: huge.tooLarge, size: huge.size, body: huge.body, b64: huge.bodyBase64 },
      sub: JSON.parse(sub.body).headers.cookie, same: JSON.parse(same.body).headers.cookie };
  });
  check('50 MB body cap', [guard.huge.tooLarge, guard.huge.body, guard.huge.b64], [true, null, null]);
  check('cookie not sent after redirect to a subdomain', guard.sub, undefined);
  check('cookie kept after same-origin redirect', guard.same, 's=1');
  check('session rules removed', await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), []);
  // A second send without Cookie must not carry the old one or the Set-Cookie from the response.
  const r2 = await sw.evaluate(() => postcatSend({ method: 'GET', url: 'http://localhost:8765/b', headers: [], body: 'ignored' }));
  check('no cookie leaks into the next send', 'cookie' in JSON.parse(r2.body).headers, false);

  // ---------- panel: capture, filter, edit, send, save ----------
  const { page, errors } = await openPanel(ctx, id, { width: 1300, height: 600 });
  await page.evaluate(() => {
    const headers = (method) => [{ name: ':method', value: method }, { name: 'accept', value: 'application/json' }, { name: 'cookie', value: 'sid=1' }];
    const json = { time: 42, resHeaders: [{ name: 'content-type', value: 'application/json' }], content: '{"recorded":true}' };
    __emit(harEntry({ ...json, method: 'GET', url: 'http://localhost:8765/users?page=1', headers: headers('GET') }));
    __emit(harEntry({ ...json, method: 'POST', url: 'http://localhost:8765/users', headers: headers('POST'), type: 'xhr', status: 201, body: '{"name":"cat"}' }));
    __emit(harEntry({ ...json, method: 'GET', url: 'http://localhost:8765/logo.png', headers: headers('GET'), type: 'image' }));
  });
  // Waits (up to `timeout`) for a page-side condition; the check that follows reports the actual state.
  const settle = (fn, arg, timeout = 2000) => page.waitForFunction(fn, arg, { timeout }).catch(() => {});
  // The list renders on the next animation frame: wait (up to `timeout`) for the expected row count
  // instead of sleeping; the check that follows reports the actual count.
  const rows = () => page.locator('#requestList li[data-id]').count();
  const listHas = async (n, what, timeout = 2000) => {
    await waitForRows(page, n, timeout).catch(() => {});
    check(`${what}: ${n} rows`, await rows(), n);
  };
  const sendDone = () => waitForSendDone(page);
  // Secondary actions live in popover menus: open the menu, click the item (the menu closes itself).
  const viaMenu = async (trigger, item) => { await page.click(trigger); await page.click(item); };
  // Whether a menu item is offered right now (menus hide what doesn't apply), leaving the menu closed.
  const inMenu = async (trigger, item) => {
    await page.click(trigger);
    const visible = await page.isVisible(item);
    await page.keyboard.press('Escape');
    return visible;
  };
  // chrome.storage writes are debounced (storage.js): waits until `key` holds a record `test`
  // accepts (page.waitForFunction can't await the async storage API), then returns what is there.
  const stored = async (key, test = () => true, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    let value;
    do {
      value = await page.evaluate(async (key) => (await chrome.storage.local.get(key))[key], key);
      if (test(value)) break;
      await new Promise((r) => setTimeout(r, 25));
    } while (Date.now() < deadline);
    return value;
  };

  await listHas(2, 'XHR-only capture');
  await page.fill('#filterInput', '/POST/');
  await listHas(1, 'regex filter');
  await page.locator('#requestList li').first().click();
  includes('recorded body shown', await page.textContent('#resBody'), '"recorded": true');
  // Edit the body and send.
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"name":"edited"}');
  await page.click('#sendBtn');
  await sendDone();
  const replayed = JSON.parse(await page.textContent('#resBody'));
  check('edited body sent', replayed.body, '{"name":"edited"}');
  check('recorded cookie sent', replayed.headers.cookie, 'sid=1');
  ok('JSON response highlighted', (await page.locator('#resBody .j-key').count()) > 0, 'no .j-key spans');
  check('edited marker on the row', await page.locator('#requestList li.selected .edited').count(), 1);
  check('Reset offered in the More menu', await inMenu('#moreBtn', '#resetBtn'), true);
  check('header count', await page.textContent('#reqHeaderCount'), '2');
  // Recorded vs. sent response toggle.
  await page.selectOption('#resSource', 'recorded');
  includes('recorded view', await page.textContent('#resBody'), '"recorded": true');
  await page.selectOption('#resSource', 'sent');

  await page.click('#saveBtn');
  check('saved to storage', (await stored('postcat.saved', (s) => s?.length === 1))?.length, 1);
  check('Save disabled for a saved item (autosave)', await page.isDisabled('#saveBtn'), true);
  // Saved items autosave.
  await page.fill('#name', 'My call');
  check('name autosaved', (await stored('postcat.saved', (s) => s?.[0]?.name === 'My call'))?.[0]?.name, 'My call');

  // ---------- panel: keyboard navigation, reset, params and headers tables, cURL paste, delete ----------
  await page.selectOption('#collection', 'captured');
  await page.fill('#filterInput', '');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  match('ArrowDown selects the next row', await page.inputValue('#url'), /\/users\?page=1$/);
  await page.keyboard.press('ArrowUp');
  match('ArrowUp selects the previous row', await page.inputValue('#url'), /\/users$/);
  await viaMenu('#moreBtn', '#resetBtn');
  await settle(() => !document.querySelector('#requestList li .edited'));
  check('Reset restores the body', await page.inputValue('#body'), '{"name":"cat"}');
  check('Reset clears the marker', await page.locator('#requestList li .edited').count(), 0);

  // The params table edits the URL; the headers table toggles lines.
  await page.keyboard.press('ArrowDown'); // -> GET /users?page=1
  await page.click('#reqTabs button[data-tab=params]');
  check('param count', await page.textContent('#reqParamCount'), '1');
  await page.locator('#paramsView .kv-row').last().locator('.kv-key').fill('limit');
  await page.locator('#paramsView .kv-row').nth(1).locator('.kv-value').fill('5');
  match('params table edits the URL', await page.inputValue('#url'), /\/users\?page=1&limit=5$/);
  await page.click('#reqTabs button[data-tab=headers]');
  await page.locator('#headersView .kv-row').first().locator('input[type=checkbox]').uncheck();
  check('disabled header not counted', await page.textContent('#reqHeaderCount'), '1');

  // Pasting a cURL command outside inputs creates a saved request.
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', "curl 'http://localhost:8765/from-curl' -H 'x-from: curl' --data-raw 'hi'");
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  match('cURL URL imported', await page.inputValue('#url'), /\/from-curl$/);
  check('cURL method imported', await page.inputValue('#method'), 'POST');
  await page.click('#sendBtn');
  await sendDone();
  const curlEcho = JSON.parse(await page.textContent('#resBody'));
  check('cURL header sent', curlEcho.headers['x-from'], 'curl');
  check('cURL body sent', curlEcho.body, 'hi');

  // Delete with undo; the tab and editor tab reach storage.
  check('saved list', await rows(), 2);
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Delete');
  await listHas(1, 'after Delete');
  await page.click('#toastAction');
  await listHas(2, 'after Undo');
  const settings = await stored('postcat.settings', (s) => s?.tab === 'saved' && s?.reqTab === 'headers');
  check('settings persisted', [settings?.tab, settings?.reqTab], ['saved', 'headers']);

  // ---------- panel: recorded bodies survive a navigation of the inspected page ----------
  // Real DevTools' getContent() returns nothing once the inspected page navigated (verified in
  // test/real-devtools.js), so bodies must be fetched at capture time. The stub decides when it
  // is called, not when it answers, so Import and the "navigation" need no sleep in between.
  await page.evaluate(() => {
    window.__navigated = false;
    const entry = harEntry({ started: 'imported-1', time: 12, url: 'http://localhost:8765/imported' });
    entry.getContent = (cb) => { const gone = window.__navigated; setTimeout(() => cb(gone ? null : '{"imported":true}', ''), 10); };
    window.__har = [entry];
  });
  await viaMenu('#captureBtn', '#importBtn');
  await page.evaluate(() => { window.__navigated = true; });
  await page.fill('#filterInput', 'imported');
  await page.selectOption('#collection', 'captured');
  await listHas(1, 'imported');
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#resTabs button[data-tab=resBody]');
  await settle(() => document.getElementById('resBody').textContent.includes('"imported": true'));
  includes('imported body kept across navigation', await page.textContent('#resBody'), '"imported": true');

  // ---------- media and binary responses ----------
  // Replay path: binary comes back as base64, text as text.
  const media = await sw.evaluate(async () => {
    const get = (url) => postcatSend({ method: 'GET', url: `http://localhost:8765${url}`, headers: [], body: '' });
    const [png, octet, html, bin] = await Promise.all(['/media/img.png', '/media/octet', '/media/page.html', '/media/blob.bin'].map(get));
    return { png, octet, html, bin };
  });
  check('replayed PNG is base64 only', [media.png.body, media.png.bodyBase64], [null, PNG_1x1]);
  ok('replayed octet-stream is base64', media.octet.bodyBase64 != null, 'bodyBase64 missing');
  check('replayed HTML is text', media.html.body, '<h1>Hello page</h1>');
  ok('replayed binary is base64', media.bin.bodyBase64 != null, 'bodyBase64 missing');

  // Recorded path: DevTools hands out base64 for binary content.
  await page.evaluate((png) => {
    const media = (path, o) => harEntry({ started: `media-${path}`, time: 5, url: `http://localhost:8765${path}`, ...o });
    __emit(media('/media/img.png', { mime: 'image/png', content: png, encoding: 'base64' }));
    __emit(media('/media/clip.mp4', { mime: 'video/mp4', content: btoa('\0\0\0\x20ftypisom not really a video'), encoding: 'base64' }));
    __emit(media('/media/blob.bin', { mime: 'application/octet-stream', content: btoa('\0\x01\x02\x03binary'), encoding: 'base64' }));
    __emit(media('/media/page.html', { mime: 'text/html', content: '<h1>Hello page</h1>' }));
    __emit(media('/media/nocopy', { mime: 'image/png', resHeaders: [{ name: 'content-length', value: '70' }] }));
    __emit(media('/media/empty', { mime: 'text/plain', status: 204 }));
    __emit(media('/media/failed', { mime: '', status: 0, error: 'net::ERR_FAILED' }));
    __emit(media('/media/redirect', { mime: '', status: 302, resHeaders: [{ name: 'location', value: '/media/img.png' }] }));
  }, PNG_1x1);
  await page.selectOption('#collection', 'captured');
  await page.fill('#filterInput', '/media/');
  await listHas(8, 'media filter');
  const pick = async (path) => {
    await page.locator('#requestList li[data-id]', { hasText: path }).first().click();
    await page.click('#resTabs button[data-tab=resBody]');
  };
  const imgLoaded = () => page.waitForFunction(() => document.querySelector('#resPreview img')?.naturalWidth === 1, null, { timeout: 3000 }).then(() => true, () => false);

  await pick('/media/img.png');
  check('recorded image previewed', await imgLoaded(), true);
  match('image caption', await page.textContent('#resPreview .caption'), /^1 × 1 · image\/png/);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), viaMenu('#resMenuBtn', '#saveResBtn')]);
  check('Save downloads the file', download?.suggestedFilename(), 'img.png');
  await page.click('#resMode button[data-mode=raw]');
  includes('raw view is a hex dump', await page.textContent('#resBody'), '|.PNG');
  await page.click('#resMode button[data-mode=preview]');
  await page.click('#sendBtn');
  await sendDone().catch(() => {});
  check('replayed image previewed', await imgLoaded(), true);

  await pick('/media/clip.mp4');
  check('video preview', await page.locator('#resPreview video').count(), 1);

  await pick('/media/blob.bin');
  const binHex = await page.textContent('#resBody');
  match('binary shows its type', binHex, /^application\/octet-stream/);
  includes('binary hex dump', binHex, '00 01 02 03');
  check('Copy not offered for binary', await inMenu('#resMenuBtn', '#copyResBtn'), false);
  check('Save offered for binary', await inMenu('#resMenuBtn', '#saveResBtn'), true);

  await pick('/media/page.html');
  check('HTML shown raw by default', await page.textContent('#resBody'), '<h1>Hello page</h1>');
  await page.click('#resMode button[data-mode=preview]');
  includes('HTML preview in an iframe', await page.locator('#resPreview iframe').getAttribute('srcdoc'), '<h1>Hello page</h1>');
  check('HTML preview sandboxed', await page.locator('#resPreview iframe').getAttribute('sandbox'), '');

  await pick('/media/nocopy');
  includes('no-copy notice', await page.textContent('#resPreview .notice').catch(() => ''), 'kept no copy');
  await pick('/media/empty');
  check('empty body message', await page.textContent('#resBody'), 'Empty response body.');
  await pick('/media/failed');
  includes('failed request notice', await page.textContent('#resPreview .notice').catch(() => ''), 'net::ERR_FAILED');
  await pick('/media/redirect');
  check('redirect message', await page.textContent('#resBody'), 'Redirect → /media/img.png');
  // Multipart bodies get a warning in the body status line.
  await page.click('#newListBtn');
  await page.selectOption('#method', 'POST');
  await page.click('#reqTabs button[data-tab=headers]');
  await viaMenu('#reqMenuBtn', '#bulkBtn');
  await page.fill('#headers', 'Content-Type: multipart/form-data; boundary=x');
  await viaMenu('#reqMenuBtn', '#bulkBtn');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--');
  match('multipart warning', await page.textContent('#bodyStatus'), /^⚠ Multipart/);
  await page.selectOption('#collection', 'captured');

  // ---------- editor: info line, Enter to send, DevTools search, JSON validation, cancel, errors ----------
  match('info line on a captured request', await page.textContent('#info'), /^Captured( [^·]+)? · fetch · 5 ms$/);

  // Enter in the URL field sends.
  await page.click('#newListBtn');
  await page.fill('#url', 'http://localhost:8765/echo?x=1');
  await page.press('#url', 'Enter');
  await sendDone();
  check('Enter sends', JSON.parse(await page.textContent('#resBody')).url, '/echo?x=1');

  // Search through DevTools' search bar (devtools.js forwards to window.postcatSearch).
  // Expected count straight from the rendered text (case-insensitive, non-overlapping).
  const expectedMatches = await page.evaluate(() => document.getElementById('resBody').textContent.toLowerCase().split('e').length - 1);
  ok('search fixture has several matches', expectedMatches > 5, `${expectedMatches} matches`);
  await page.evaluate(() => window.postcatSearch('performSearch', 'E'));
  check('search count', await page.textContent('#searchCount'), `1 / ${expectedMatches}`);
  check('search highlights', await page.evaluate(() => CSS.highlights.get('postcat-match')?.size || 0), expectedMatches);
  await page.evaluate(() => window.postcatSearch('nextSearchResult'));
  check('next search result', await page.textContent('#searchCount'), `2 / ${expectedMatches}`);
  await page.evaluate(() => window.postcatSearch('performSearch', '"x-from'));  // no match in this body
  check('no matches', await page.textContent('#searchCount'), 'No matches');
  await page.evaluate(() => window.postcatSearch('cancelSearch'));
  check('search count hidden after cancel', await page.isVisible('#searchCount'), false);

  // JSON validation of the request body.
  await page.selectOption('#method', 'POST');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"a": 1,}');
  includes('JSON error position', await page.textContent('#bodyStatus'), 'line 1, column 9');
  includes('JSON error mark', await page.getAttribute('#reqBodyMark', 'class'), 'bad');
  await page.fill('#body', '{"a": 1}');
  check('valid JSON status', await page.textContent('#bodyStatus'), '✓ Valid JSON');

  // Cancel a slow request.
  await page.fill('#url', 'http://localhost:8765/slow');
  await page.click('#sendBtn');
  check('button reads Cancel while sending', await page.textContent('#sendBtn'), 'Cancel');
  const t0 = Date.now();
  await page.click('#sendBtn');
  await settle(() => document.getElementById('resBody').textContent === 'Request cancelled.', null, 3000);
  check('cancelled', await page.textContent('#resBody'), 'Request cancelled.');
  ok('cancel is immediate', Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  check('button reads Send again', await page.textContent('#sendBtn'), 'Send');

  // Readable network errors.
  await page.fill('#url', 'http://localhost:1/nothing');
  await page.click('#sendBtn');
  await sendDone().catch(() => {});
  await settle(() => /Couldn’t reach/.test(document.getElementById('resBody').textContent), null, 5000);
  match('network error message', await page.textContent('#resBody'), /^Couldn’t reach localhost:1\./);

  // ---------- data fidelity and list bookkeeping ----------
  const newRequest = async (url) => { await page.click('#newListBtn'); await page.fill('#url', url); };

  // Big integers survive response formatting and request-body beautify.
  await newRequest('http://localhost:8765/big');
  await page.click('#sendBtn');
  await sendDone();
  const bigResponse = await page.textContent('#resBody');
  includes('big integer kept in the response', bigResponse, '12345678901234567890');
  includes('number spelling kept in the response', bigResponse, '1.10');
  await page.selectOption('#method', 'POST');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"id":12345678901234567890}');
  await viaMenu('#reqMenuBtn', '#beautifyBtn');
  check('Beautify keeps big integers', await page.inputValue('#body'), '{\n  "id": 12345678901234567890\n}');

  // Editing one query param keeps the others byte-for-byte.
  await newRequest('http://localhost:8765/p?redirect=https%3A%2F%2Fx.com%2F&q=a+b&sig=abc');
  await page.click('#reqTabs button[data-tab=params]');
  await page.locator('#paramsView .kv-row').nth(2).locator('.kv-value').fill('xyz');
  check('untouched params kept raw', await page.inputValue('#url'), 'http://localhost:8765/p?redirect=https%3A%2F%2Fx.com%2F&q=a+b&sig=xyz');

  // Deleting a request while it's sending, then Undo: not stuck on "Cancel", queue not blocked.
  await newRequest('http://localhost:8765/slow');
  await page.click('#sendBtn');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Delete');
  await page.click('#toastAction');
  check('Send button after Delete + Undo', await page.textContent('#sendBtn'), 'Send');
  const t1 = Date.now();
  await page.fill('#url', 'http://localhost:8765/after-undo');
  await page.click('#sendBtn');
  await sendDone();
  includes('next send goes through', await page.textContent('#resBody'), '/after-undo');
  ok('queue not blocked by the abandoned send', Date.now() - t1 < 3000, `took ${Date.now() - t1} ms`);

  // Identical requests in the same millisecond are two entries; Import adds only what's missing.
  await page.selectOption('#collection', 'captured');
  await page.fill('#filterInput', '/twin');
  await page.evaluate(() => {
    const twin = () => harEntry({ started: 'twin-ms', time: 3, url: 'http://localhost:8765/twin', content: '{}' });
    __emit(twin());
    __emit(twin());
    window.__har = [twin(), twin(), twin()];
  });
  await listHas(2, 'identical requests');
  await viaMenu('#captureBtn', '#importBtn');
  await listHas(3, 'Import adds only the missing one');

  // Clear + Undo keeps sent responses; Import after Clear doesn't bring cleared requests back.
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#sendBtn');
  await sendDone();
  await viaMenu('#captureBtn', '#clearBtn');
  await viaMenu('#captureBtn', '#importBtn');
  await listHas(0, 'Import after Clear');
  // The Import toast replaced Clear's Undo, so test Undo from a fresh capture.
  await page.evaluate(() => __emit(harEntry({ started: 'solo', time: 3, url: 'http://localhost:8765/twin-solo', status: 299, statusText: 'Recorded', content: '{}' })));
  await listHas(1, 'fresh capture');
  await page.locator('#requestList li[data-id]').first().click();
  await page.click('#sendBtn');
  await sendDone();
  await viaMenu('#captureBtn', '#clearBtn');
  await page.click('#toastAction');
  await listHas(1, 'Clear + Undo');
  check('sent response kept across Clear + Undo', await page.locator('#requestList li[data-id] .status').first().textContent(), '200');

  // The 1000-entry cap never drops the request open in the editor.
  await page.fill('#filterInput', '');
  await page.evaluate(() => {
    for (let i = 0; i < 1000; i++) __emit(harEntry({ started: `bulk-${i}`, url: `http://localhost:8765/bulk/${i}`, mime: '' }));
  });
  await listHas(1000, 'capped list', 5000);
  check('selected row survives the cap', await page.locator('#requestList li.selected').count(), 1);

  // ---------- list: key repeat, scroll position, corrupt storage ----------
  // Holding Delete (key repeat) removes only one request.
  await page.selectOption('#collection', 'captured');
  await page.fill('#filterInput', '/bulk/');
  await listHas(999, 'bulk filter');
  await page.locator('#requestList li[data-id]').first().click();
  await page.evaluate(() => {
    document.activeElement.blur();
    for (let i = 0; i < 5; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', repeat: i > 0, bubbles: true }));
  });
  await listHas(998, 'key repeat removes one');

  // Typing in the editor must not scroll the list back to the selected row.
  const secondSelected = () => document.querySelectorAll('#requestList li[data-id]')[1]?.classList.contains('selected');
  await page.locator('#requestList li[data-id]').nth(1).click();
  await settle(secondSelected);
  check('clicked row selected', await page.evaluate(secondSelected), true);
  await page.evaluate(() => { document.getElementById('requestList').scrollTop = 4000; });
  const scrollBefore = await page.evaluate(() => document.getElementById('requestList').scrollTop);
  await page.type('#url', 'x');
  // The edit re-renders the list on the next frame (the edited marker appears); the scroll position must survive it.
  await settle(() => document.querySelector('#requestList li.selected .edited'));
  check('list re-rendered after typing', await page.locator('#requestList li.selected .edited').count(), 1);
  ok('list scrolled away', scrollBefore > 0, `scrollTop ${scrollBefore}`);
  check('typing keeps the scroll position', await page.evaluate(() => document.getElementById('requestList').scrollTop), scrollBefore);

  // Corrupt saved records and invalid layout in storage must not break the panel.
  // The panel flushes pending debounced writes on pagehide (storage.js), which would overwrite what
  // is injected here: wait for the last settings change (the filter) to land in storage first.
  check('filter persisted before reload', (await stored('postcat.settings', (s) => s?.filterText === '/bulk/'))?.filterText, '/bulk/');
  await page.evaluate(() => chrome.storage.local.set({
    'postcat.saved': [{ name: 'ok', method: 'get', url: 'http://a.test', headersText: '', body: '' }, { url: 'http://no-method.test' }, null, 'junk'],
    'postcat.settings': { layout: { sidebarW: null, reqW: 'wide' }, tab: 'saved', reqTab: 'nope' },
  }));
  await page.reload();
  await listHas(2, 'valid records after reload', 3000);
  const afterReload = await page.evaluate(() => ({
    saved: [...document.querySelectorAll('#requestList li[data-id]')].map((li) => li.title.split('\n')[0]),
    columns: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
    sidebarW: document.documentElement.style.getPropertyValue('--sidebar-w'),
  }));
  check('corrupt records skipped', afterReload.saved, ['GET http://a.test', 'GET http://no-method.test']);
  match('invalid layout falls back to numbers', afterReload.columns, /^\d+(\.\d+)?px \d+(\.\d+)?px \d+(\.\d+)?px$/);
  check('sidebar width default', afterReload.sidebarW, '214px');

  // ---------- layouts: wide / medium / narrow follow the panel width ----------
  // One captured request with a recorded response and distinctive headers, replayed later for Recorded / Sent.
  await page.setViewportSize({ width: 1024, height: 320 });
  await page.selectOption('#collection', 'captured');
  await page.evaluate(() => __emit(harEntry({
    started: 'layout-1', time: 7, url: 'http://localhost:8765/layout?x=1',
    resHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'x-source', value: 'recorded' }], content: '{"recorded":true}',
  })));
  await listHas(1, 'layout fixture');
  await page.locator('#requestList li[data-id]').first().click();
  const modeFor = (w) => (w >= 850 ? 'wide' : w >= 580 ? 'medium' : 'narrow');
  const resize = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await settle((mode) => document.getElementById('app').dataset.layout === mode, modeFor(w));
  };
  // What the user can see at this size: the layout attributes, overflow of the app root, and whether
  // the essential controls are on screen (rendered, and inside the viewport).
  const shape = () => page.evaluate(() => {
    const app = document.getElementById('app');
    const onScreen = (id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return el.checkVisibility() && r.width > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5;
    };
    return {
      layout: app.dataset.layout, screen: app.dataset.screen, view: app.dataset.view,
      overflow: [app.scrollWidth > app.clientWidth, app.scrollHeight > app.clientHeight],
      send: onScreen('sendBtn'), list: onScreen('requestList'), switcher: onScreen('viewTabs'), req: onScreen('reqTabs'), res: onScreen('resTabs'),
      listScrolls: document.getElementById('requestList').scrollHeight > document.getElementById('requestList').clientHeight,
    };
  });
  for (const [w, h] of [[1024, 320], [1024, 240], [850, 300], [680, 280], [580, 240], [380, 480], [320, 260]]) {
    await resize(w, h);
    const s = await shape();
    const mode = modeFor(w);
    check(`${w}×${h}: ${mode} layout`, s.layout, mode);
    check(`${w}×${h}: app root does not overflow`, s.overflow, [false, false]);
    check(`${w}×${h}: Send on screen`, s.send, true);
    if (mode === 'wide') check(`${w}×${h}: list, request and response side by side`, [s.list, s.req, s.res, s.switcher], [true, true, true, false]);
    else if (mode === 'medium') check(`${w}×${h}: list plus one switched pane`, [s.list, s.switcher, s.req, s.res], [true, true, s.view === 'request', s.view === 'response']);
    else check(`${w}×${h}: details fill the width`, [s.screen, s.list, s.switcher, s.req || s.res], ['detail', false, true, true]);
  }

  // Drafts and the selection survive crossing both breakpoints while editing URL, param, header and body.
  await resize(1024, 320);
  await page.fill('#url', 'http://localhost:8765/layout?x=1&keep=me');
  await page.click('#reqTabs button[data-tab=params]');
  await page.locator('#paramsView .kv-row').nth(1).locator('.kv-value').fill('kept');
  await page.click('#reqTabs button[data-tab=headers]');
  await page.locator('#headersView .kv-row').last().locator('.kv-key').fill('X-Kept');
  await page.locator('#headersView .kv-row').first().locator('.kv-value').fill('yes');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '{"kept": true}');
  const draft = () => page.evaluate(() => ({
    url: document.getElementById('url').value, body: document.getElementById('body').value,
    header: document.querySelector('#headersView .kv-row .kv-key').value + ': ' + document.querySelector('#headersView .kv-row .kv-value').value,
    params: document.getElementById('reqParamCount').textContent, selected: document.querySelectorAll('#requestList li.selected').length,
  }));
  const expectedDraft = { url: 'http://localhost:8765/layout?x=1&keep=kept', body: '{"kept": true}', header: 'X-Kept: yes', params: '2', selected: 1 };
  check('draft before resizing', await draft(), expectedDraft);
  await resize(680, 280);
  check('draft kept in the medium layout', await draft(), expectedDraft);
  await resize(380, 480);
  check('draft kept in the narrow layout', await draft(), expectedDraft);
  await resize(1024, 320);
  check('draft kept back in the wide layout', await draft(), expectedDraft);

  // Focus follows the layout: a pane that loses its side-by-side place is the one shown, focus intact.
  await page.focus('#resTabs button[data-tab=resHeaders]');
  await resize(680, 280);
  check('response pane shown because it had focus', await page.evaluate(() => [document.getElementById('app').dataset.view, document.activeElement.dataset.tab]), ['response', 'resHeaders']);

  // Tab lists move with the arrow keys.
  await page.click('#viewTabs button[data-view=request]');
  await page.focus('#reqTabs button[data-tab=params]');
  await page.keyboard.press('ArrowRight');
  check('ArrowRight moves to the next tab', await page.evaluate(() => [document.activeElement.dataset.tab, document.getElementById('headersView').hidden]), ['headers', false]);

  // Narrow: Requests opens the list (keyboard-accessible), a row returns to the details.
  await resize(320, 260);
  await page.click('#backBtn');
  check('Requests opens the list', await page.evaluate(() => [document.getElementById('app').dataset.screen, document.activeElement.classList.contains('selected')]), ['list', true]);
  await page.evaluate(() => { for (let i = 0; i < 40; i++) __emit(harEntry({ started: `rows-${i}`, url: `http://localhost:8765/rows/${i}`, content: '{}' })); });
  await listHas(41, 'long narrow list');
  check('long list scrolls inside the panel', (await shape()).listScrolls, true);
  await page.evaluate(() => { const list = document.getElementById('requestList'); list.scrollTop = list.scrollHeight; });
  await page.locator('#requestList li[data-id]').last().click();
  match('selecting a row returns to the details', await page.inputValue('#url'), /\/layout\?x=1&keep=kept$/);
  check('draft kept after list → details', (await draft()).body, '{"kept": true}');
  await page.click('#backBtn');
  await page.keyboard.press('ArrowUp');
  await settle(() => document.activeElement?.title.startsWith('GET http://localhost:8765/rows/0')); // the list re-renders on the next frame
  await page.keyboard.press('Enter');
  check('ArrowUp + Enter opens the previous request', [await page.evaluate(() => document.getElementById('app').dataset.screen), await page.inputValue('#url')], ['detail', 'http://localhost:8765/rows/0']);
  await page.click('#backBtn');
  await page.locator('#requestList li[data-id]').last().click();

  // Response: Body ↔ Headers directly, for Recorded and Sent; headers follow the source.
  await page.click('#viewTabs button[data-view=response]');
  await page.click('#resTabs button[data-tab=resHeaders]');
  includes('recorded headers (narrow)', await page.textContent('#resHeaders'), 'x-source');
  await page.click('#resTabs button[data-tab=resBody]');
  includes('recorded body (narrow)', await page.textContent('#resBody'), '"recorded": true');
  await page.click('#viewTabs button[data-view=request]');
  await page.click('#sendBtn');
  await sendDone();
  check('Send reveals the response', await page.evaluate(() => document.getElementById('app').dataset.view), 'response');
  check('Sent selected after the send', await page.inputValue('#resSource'), 'sent');
  includes('sent body', await page.textContent('#resBody'), '"url": "/layout?x=1&keep=kept"');
  await page.click('#resTabs button[data-tab=resHeaders]');
  const sentHeaders = await page.textContent('#resHeaders');
  ok('sent headers follow the source', sentHeaders.includes('content-type') && !sentHeaders.includes('x-source'), sentHeaders);
  await page.selectOption('#resSource', 'recorded');
  includes('recorded headers after switching the source', await page.textContent('#resHeaders'), 'x-source');
  await page.click('#resTabs button[data-tab=resBody]');
  includes('recorded body after switching the source', await page.textContent('#resBody'), '"recorded": true');
  await resize(1024, 320);
  await page.selectOption('#resSource', 'sent');
  await page.click('#resTabs button[data-tab=resHeaders]');
  check('Headers tab (wide)', await page.evaluate(() => [document.querySelector('#resTabs [data-tab=resHeaders]').getAttribute('aria-selected'), document.getElementById('resHeaders').hidden]), ['true', false]);
  ok('sent headers (wide)', !(await page.textContent('#resHeaders')).includes('x-source'), 'recorded headers shown for the sent response');
  await page.click('#resTabs button[data-tab=resBody]');
  includes('sent body (wide)', await page.textContent('#resBody'), '"url": "/layout?x=1&keep=kept"');

  // A request without a response shows an empty state, not a status.
  await page.click('#newListBtn');
  includes('empty response state', await page.textContent('#resBody'), 'No response yet');
  check('no status without a response', [await page.textContent('#resStatus'), await page.textContent('#viewResStatus'), await page.isVisible('#resSource')], ['', '', false]);

  // Appearance: Light / Dark / System, persisted with the settings.
  await page.click('#captureBtn');
  await page.click('#appearance button[data-appearance=light]');
  check('light appearance', await page.evaluate(() => document.documentElement.classList.contains('dark')), false);
  check('appearance persisted', (await stored('postcat.settings', (s) => s?.appearance === 'light'))?.appearance, 'light');
  await page.click('#captureBtn');
  await page.click('#appearance button[data-appearance=system]');
  check('system appearance follows DevTools', await page.evaluate(() => document.documentElement.classList.contains('dark')), true);

  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  check('no uncaught panel errors', errors, []);
  await ctx.close();
  cleanup();
  server.close();
  console.log(`e2e ok (${passed} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
