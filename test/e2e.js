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
  // Response body actions are inline controls that move into the response ⋯ menu when the pane is
  // too narrow for them: use the inline control when it is shown, else the menu item.
  const bodyAction = async (inline, item) => ((await page.isVisible(inline)) ? page.click(inline) : viaMenu('#resMenuBtn', item));
  const bodyActionOffered = async (inline, item) => (await page.isVisible(inline)) || (await page.isVisible('#resMenuBtn') && inMenu('#resMenuBtn', item));
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
  check('Rename not offered for a captured request', await inMenu('#moreBtn', '#renameBtn'), false);
  check('header count', await page.textContent('#reqHeaderCount'), '2');
  // Recorded vs. sent response toggle.
  await page.selectOption('#resSource', 'recorded');
  includes('recorded view', await page.textContent('#resBody'), '"recorded": true');
  await page.selectOption('#resSource', 'sent');

  await page.click('#saveBtn');
  check('saved to storage', (await stored('postcat.saved', (s) => s?.length === 1))?.length, 1);
  check('Save disabled for a saved item (autosave)', await page.isDisabled('#saveBtn'), true);
  // Saved items autosave. The name is edited in the list row; the Save toast offers the rename.
  check('Save toast offers Rename', [await page.textContent('#toastText'), await page.textContent('#toastAction')], ['Saved', 'Rename']);
  await page.click('#toastAction');
  await settle(() => document.activeElement?.id === 'name'); // rendered on the next frame
  check('Rename from the toast opens the inline rename in the list row', await page.evaluate(() => [document.activeElement.id, !!document.activeElement.closest('#requestList li.selected')]), ['name', true]);
  await page.fill('#name', 'My call');
  await page.press('#name', 'Enter');
  check('name autosaved', (await stored('postcat.saved', (s) => s?.[0]?.name === 'My call'))?.[0]?.name, 'My call');
  await settle(() => document.querySelector('#requestList li.selected .path')?.textContent === 'My call');
  check('row shows the new name', await page.textContent('#requestList li.selected .path'), 'My call');
  // F2 on the focused row renames too; Escape discards; a double-click opens it as well; the ⋯ menu offers Rename.
  await page.focus('#requestList li.selected');
  await page.keyboard.press('F2');
  await settle(() => document.activeElement?.id === 'name');
  await page.fill('#name', 'Renamed by F2');
  await page.press('#name', 'Enter');
  check('rename via F2 persists', (await stored('postcat.saved', (s) => s?.[0]?.name === 'Renamed by F2'))?.[0]?.name, 'Renamed by F2');
  await page.focus('#requestList li.selected');
  await page.keyboard.press('F2');
  await settle(() => document.activeElement?.id === 'name');
  await page.fill('#name', 'discarded');
  await page.press('#name', 'Escape');
  await settle(() => !document.getElementById('name'));
  check('Escape discards the rename', [await page.textContent('#requestList li.selected .path'), (await stored('postcat.saved'))?.[0]?.name], ['Renamed by F2', 'Renamed by F2']);
  await page.dblclick('#requestList li.selected');
  await settle(() => document.activeElement?.id === 'name');
  check('double-click opens the rename', await page.evaluate(() => document.activeElement.id), 'name');
  await page.press('#name', 'Escape');
  await settle(() => !document.getElementById('name'));
  check('Rename offered in the ⋯ menu for a saved request', await inMenu('#moreBtn', '#renameBtn'), true);
  // Right-click on a row: the same menu at the pointer, with Rename for a saved row; Escape closes it.
  await page.click('#requestList li.selected', { button: 'right' });
  await settle(() => document.getElementById('moreMenu').matches(':popover-open'));
  check('right-click on a saved row opens the request menu with Rename', await page.evaluate(() => [document.getElementById('moreMenu').matches(':popover-open'), ['renameBtn', 'dupBtn', 'curlBtn', 'deleteBtn'].map((id) => document.getElementById(id).checkVisibility()), document.getElementById('moreBtn').getAttribute('aria-expanded')]), [true, [true, true, true, true], 'true']);
  await page.keyboard.press('Escape');
  check('Escape closes the row menu', await page.evaluate(() => [document.getElementById('moreMenu').matches(':popover-open'), document.getElementById('moreBtn').getAttribute('aria-expanded')]), [false, 'false']);

  // ---------- panel: keyboard navigation, reset, params and headers tables, cURL paste, delete ----------
  // Captured / Saved are direct tabs with counts: Save switched to Saved, one click switches back,
  // Left/Right move between them when focused. No dropdown anywhere in the list toolbar.
  const collectionTabs = () => page.evaluate(() => [...document.querySelectorAll('#collection [role=tab]')].map((b) => [b.dataset.tab, b.getAttribute('aria-selected'), b.querySelector('.count').textContent, b.checkVisibility()]));
  await page.fill('#filterInput', ''); // the /POST/ filter would hide one captured row
  check('Save switches to the Saved tab (with counts)', await collectionTabs(), [['captured', 'false', '2', true], ['saved', 'true', '1', true]]);
  check('no dropdown in the list toolbar', await page.evaluate(() => [document.getElementById('collection').getAttribute('role'), document.querySelector('#listTools select')]), ['tablist', null]);
  await page.click('#collectionCaptured');
  await listHas(2, 'Captured tab');
  check('Captured tab selected', (await collectionTabs()).map((t) => t[1]), ['true', 'false']);
  await page.focus('#collectionCaptured');
  await page.keyboard.press('ArrowRight');
  await listHas(1, 'ArrowRight opens Saved');
  check('ArrowRight moves to the Saved tab', [await page.evaluate(() => document.activeElement.id), (await collectionTabs()).map((t) => t[1])], ['collectionSaved', ['false', 'true']]);
  await page.keyboard.press('ArrowLeft');
  await listHas(2, 'ArrowLeft back to Captured');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  match('ArrowDown selects the next row', await page.inputValue('#url'), /\/users\?page=1$/);
  await page.keyboard.press('ArrowUp');
  match('ArrowUp selects the previous row', await page.inputValue('#url'), /\/users$/);

  // Keys inside an open menu stay in the menu: arrows move between its items without touching the
  // list selection, and Backspace on a focused item does not delete the request.
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // the list renders on the next frame
  const selectedId = () => page.evaluate(() => document.querySelector('#requestList li.selected')?.dataset.id);
  await frames();
  const selectedBeforeMenu = await selectedId();
  const rowsBeforeMenu = await rows();
  await page.focus('#moreBtn');
  await page.keyboard.press('Enter');
  await settle(() => document.activeElement?.id === 'resetBtn'); // the first item is focused on `toggle`
  check('Enter on the ⋯ button opens its menu', await page.evaluate(() => [document.getElementById('moreBtn').getAttribute('aria-expanded'), document.activeElement.id]), ['true', 'resetBtn']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  check('ArrowDown moves the focus within the menu', await page.evaluate(() => [document.activeElement.id, !!document.activeElement.closest('#moreMenu')]), ['curlBtn', true]);
  await frames();
  check('ArrowDown in a menu leaves the list selection alone', [await selectedId(), await page.inputValue('#url')], [selectedBeforeMenu, 'http://localhost:8765/users']);
  await page.keyboard.press('Backspace');
  await frames(); // a delete would have rendered by now
  check('Backspace on a menu item deletes nothing', [await rows(), await selectedId()], [rowsBeforeMenu, selectedBeforeMenu]);
  await page.keyboard.press('Escape');
  check('Escape closes the menu', await page.getAttribute('#moreBtn', 'aria-expanded'), 'false');
  check('menu triggers announce their menu', await page.evaluate(() => [...document.querySelectorAll('[popovertarget]')].map((b) => b.getAttribute('aria-haspopup'))), ['menu', 'menu', 'menu']);

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
  await page.click('#collectionCaptured');
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
  await page.click('#collectionCaptured');
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
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), bodyAction('#resSave', '#saveResBtn')]);
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
  check('Copy not offered for binary', await bodyActionOffered('#resCopy', '#copyResBtn'), false);
  check('Save offered for binary', await bodyActionOffered('#resSave', '#saveResBtn'), true);

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
  await page.click('#bulkBtn');
  check('Bulk edit becomes Table view', await page.evaluate(() => [document.getElementById('bulkBtn').textContent, document.getElementById('bulkBtn').getAttribute('aria-label')]), ['Table view', 'Table view']);
  await page.fill('#headers', 'Content-Type: multipart/form-data; boundary=x');
  await page.click('#bulkBtn');
  await page.click('#reqTabs button[data-tab=body]');
  await page.fill('#body', '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--');
  match('multipart warning', await page.textContent('#bodyStatus'), /^⚠ Multipart/);
  await page.click('#collectionCaptured');

  // ---------- editor: info line, Enter to send, DevTools search, JSON validation, cancel, errors ----------
  // No context row: the capture details sit in the tooltips of the list row and the Recorded label.
  await page.locator('#requestList li[data-id]').first().click(); // /media/redirect: captured, never sent
  await settle(() => document.getElementById('resSourceLabel').checkVisibility());
  match('captured metadata in the row tooltip', await page.getAttribute('#requestList li.selected', 'title'), /^GET http:\/\/localhost:8765\/media\/redirect\nCaptured( [^·\n]+)? · fetch · 5 ms$/);
  match('captured metadata on the Recorded label', await page.getAttribute('#resSourceLabel', 'title'), /^Captured( [^·]+)? · fetch · 5 ms$/);

  // Enter in the URL field sends.
  await page.click('#newListBtn');
  await page.fill('#url', 'http://localhost:8765/echo?x=1');
  await page.press('#url', 'Enter');
  await sendDone();
  check('Enter sends', JSON.parse(await page.textContent('#resBody')).url, '/echo?x=1');
  // A never-captured request has one source: a plain "Sent" label, no selector.
  check('Sent label for a new request, no source selector', [await page.textContent('#resSourceLabel'), await page.isVisible('#resSourceLabel'), await page.isVisible('#resSource')], ['Sent', true, false]);

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
  await page.click('#beautifyBtn');
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
  await page.click('#collectionCaptured');
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
  await page.click('#collectionCaptured');
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
  // One captured request with a recorded HTML response (so Preview / Raw applies) and distinctive
  // headers, replayed later for Recorded / Sent. Its long status text must not push anything out of
  // the response header: the pill ellipsizes, the actions collapse into the ⋯ menu.
  await page.setViewportSize({ width: 1024, height: 320 });
  await page.click('#collectionCaptured');
  await page.evaluate(() => __emit(harEntry({
    started: 'layout-1', time: 7, url: 'http://localhost:8765/layout?x=1', status: 500, statusText: 'Internal Server Error', mime: 'text/html',
    resHeaders: [{ name: 'content-type', value: 'text/html' }, { name: 'x-source', value: 'recorded' }], content: '<h1>recorded</h1>',
  })));
  await listHas(1, 'layout fixture');
  await page.locator('#requestList li[data-id]').first().click();
  check('long status text in the pill and its title', [await page.textContent('#resStatus'), await page.getAttribute('#resStatus', 'title')], ['500 Internal Server Error', '500 Internal Server Error']);
  // Recorded only: a plain label, no selector to choose from.
  check('Recorded label before a send, no source selector', [await page.textContent('#resSourceLabel'), await page.isVisible('#resSourceLabel'), await page.isVisible('#resSource')], ['Recorded', true, false]);
  // No ⋯ in the request pane; each tab carries its own action (Headers: Bulk edit, Body: Beautify, Params: none).
  check('no request-pane ⋯ menu', await page.evaluate(() => [document.getElementById('reqMenuBtn'), document.querySelector('#reqTabs [popovertarget]')]), [null, null]);
  const reqActions = () => page.evaluate(() => [document.getElementById('bulkBtn').checkVisibility(), document.getElementById('beautifyBtn').checkVisibility()]);
  await page.click('#reqTabs button[data-tab=params]');
  check('Params: no contextual action', await reqActions(), [false, false]);
  await page.click('#reqTabs button[data-tab=body]');
  check('Body: Beautify only', [...await reqActions(), await page.textContent('#beautifyBtn'), await page.getAttribute('#beautifyBtn', 'aria-label')], [false, true, 'Beautify', 'Beautify JSON']);
  await page.click('#reqTabs button[data-tab=headers]');
  check('Headers: Bulk edit only', [...await reqActions(), await page.textContent('#bulkBtn')], [true, false, 'Bulk edit']);
  await page.click('#resTabs button[data-tab=resBody]');

  // Body actions (Preview/Raw, Copy, Save): inline, or in the ⋯ menu when the pane is too narrow.
  // Inline control → its menu items (Preview/Raw are two radio items in the menu).
  const PAIRS = [['resMode', 'resPreviewItem'], ['resMode', 'resRawItem'], ['resCopy', 'copyResBtn'], ['resSave', 'saveResBtn']];
  const bodyActions = () => page.evaluate((pairs) => ({
    inline: [...new Set(pairs.map(([a]) => a))].filter((id) => document.getElementById(id).checkVisibility()),
    menu: pairs.map(([, b]) => b).filter((id) => !document.getElementById(id).hidden),
    menuBtn: document.getElementById('resMenuBtn').checkVisibility(),
    // Every action offered exactly once: inline or in the menu, never both, never neither.
    once: pairs.every(([a, b]) => document.getElementById(a).checkVisibility() === document.getElementById(b).hidden),
  }), PAIRS);
  // Collapse order (Copy/Save, Preview/Raw, size, time): whatever is collapsed, everything before it is
  // collapsed too. Width-tolerant, so the checks hold with wider system fonts (CI on Linux) as well.
  const collapseOrdered = () => page.evaluate(() => {
    const shown = ['resCopy', 'resSave', 'resMode', 'resSize', 'resTime'].map((id) => document.getElementById(id)).filter((el) => !el.hidden).map((el) => el.checkVisibility());
    return shown.every((v, i) => i === 0 || !shown[i - 1] || v);
  });
  const pillShown = () => page.evaluate(() => document.getElementById('resStatus').checkVisibility());
  // Each action is offered exactly once and the header fits; the fit follows the pane's ResizeObserver
  // (next frame), so wait for it rather than reading the state left by the previous size.
  const settleActions = () => settle((pairs) => {
    const head = document.getElementById('resTabs');
    return head.scrollWidth <= head.clientWidth && pairs.every(([a, b]) => document.getElementById(a).checkVisibility() === document.getElementById(b).hidden);
  }, PAIRS);
  // Visible controls of a pane header that stick out of the pane (the header clips what overflows).
  const clipped = (paneId, headId) => page.evaluate(([paneId, headId]) => {
    const pane = document.getElementById(paneId).getBoundingClientRect();
    return [...document.querySelectorAll(`#${headId} > *, #${headId} [role=tab]`)]
      .filter((el) => el.checkVisibility() && el.getBoundingClientRect().width > 0)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.left < pane.left - .5 || r.right > pane.right + .5 || r.top < pane.top - .5 || r.bottom > pane.bottom + .5; })
      .map((el) => el.id || el.textContent.trim());
  }, [paneId, headId]);
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
    check(`${w}×${h}: context row ${mode === 'narrow' ? 'is the navigation row' : 'absent'}`, await page.evaluate(() => document.getElementById('context').checkVisibility()), mode === 'narrow');
    // The method select keeps its content width (compared with an unconstrained clone); the URL
    // field shrinks instead, and Send stays inside the viewport.
    if (mode === 'narrow') {
      for (const method of ['OPTIONS', 'DELETE']) {
        await page.selectOption('#method', method);
        check(`${w}×${h}: ${method} fully readable, Send on screen`, await page.evaluate(() => {
          const sel = document.getElementById('method');
          const clone = sel.cloneNode(true);
          Object.assign(clone.style, { position: 'absolute', left: '-9999px', width: 'auto', flex: 'none', minWidth: '0', maxWidth: 'none' });
          sel.parentElement.append(clone);
          const intrinsic = clone.getBoundingClientRect().width;
          clone.remove();
          const send = document.getElementById('sendBtn').getBoundingClientRect();
          return [sel.scrollWidth <= sel.clientWidth, sel.getBoundingClientRect().width >= intrinsic - .5, send.left >= 0 && send.right <= innerWidth + .5];
        }), [true, true, true]);
      }
      await page.selectOption('#method', 'GET'); // back to the recorded method, so the draft stays unedited
    }
    if (mode === 'wide') check(`${w}×${h}: list, request and response side by side`, [s.list, s.req, s.res, s.switcher], [true, true, true, false]);
    else if (mode === 'medium') check(`${w}×${h}: list plus one switched pane`, [s.list, s.switcher, s.req, s.res], [true, true, s.view === 'request', s.view === 'response']);
    else check(`${w}×${h}: details fill the width`, [s.screen, s.list, s.switcher, s.req || s.res], ['detail', false, true, true]);
    // Only one pane is shown outside the wide layout: switch to each before measuring its header.
    if (mode !== 'wide') await page.click('#viewTabs button[data-view=response]');
    await settleActions();
    const a = await bodyActions();
    check(`${w}×${h}: each body action offered once, ⋯ only when something is collapsed`, [a.once, a.menuBtn], [true, a.menu.length > 0]);
    // Time and size stay wherever the pane leaves room beyond doubt (≥ 375 px: 68 px+ to spare with
    // macOS fonts); at the narrower panes only the order and the status are pinned, since wider
    // system fonts legitimately collapse more there.
    check(`${w}×${h}: collapse order respected`, await collapseOrdered(), true);
    const paneW = await page.evaluate(() => document.getElementById('resPane').clientWidth);
    if (paneW >= 375) check(`${w}×${h}: time and size shown`, await page.evaluate(() => [document.getElementById('resTime').checkVisibility(), document.getElementById('resSize').checkVisibility()]), [true, true]);
    else check(`${w}×${h}: status shown`, await pillShown(), true);
    check(`${w}×${h}: nothing clipped in the response header`, await clipped('resPane', 'resTabs'), []);
    if (mode !== 'wide') await page.click('#viewTabs button[data-view=request]');
    check(`${w}×${h}: nothing clipped in the request header`, await clipped('reqPane', 'reqTabs'), []);
    check(`${w}×${h}: Bulk edit inside the request pane`, await page.evaluate(() => document.getElementById('bulkBtn').checkVisibility()), true);
    // The list toolbar (Captured / Saved tabs, record, New) fits wherever the list is shown.
    if (mode !== 'narrow') check(`${w}×${h}: nothing clipped in the list toolbar`, await clipped('sidebar', 'listTools'), []);
  }

  // Collapse order as the pane narrows: Copy/Save first, then Preview/Raw (both into the ⋯), then size,
  // then time. Medium (475 px pane): everything inline, no ⋯. Bottom dock (438 px): Copy/Save in the ⋯,
  // Preview/Raw still inline. Narrow side dock: all three in the ⋯, nothing inline, time and size kept.
  await resize(680, 280);
  await page.click('#viewTabs button[data-view=response]');
  await settleActions();
  check('680×280: Preview/Raw, Copy and Save inline, no ⋯ menu', await bodyActions(), { inline: ['resMode', 'resCopy', 'resSave'], menu: [], menuBtn: false, once: true });
  check('680×280: Copy and Save are labelled icon buttons', await page.evaluate(() => ['resCopy', 'resSave'].map((id) => [document.getElementById(id).getAttribute('aria-label'), document.getElementById(id).title])), [['Copy', 'Copy'], ['Save as file', 'Save as file…']]);
  await page.click('#viewTabs button[data-view=request]');
  await resize(1024, 320);
  await settleActions();
  // At the boundary here (the pill is at its minimum with macOS fonts): only the order is pinned.
  const at1024 = await bodyActions();
  check('1024×320: Copy/Save are the first to collapse', [await collapseOrdered(), at1024.menu.length === 0 || (at1024.menu.includes('copyResBtn') && at1024.menu.includes('saveResBtn'))], [true, true]);
  await resize(320, 260);
  await page.click('#viewTabs button[data-view=response]');
  await settleActions();
  check('320×260: all body actions in the ⋯ menu, none inline', await bodyActions(), { inline: [], menu: ['resPreviewItem', 'resRawItem', 'copyResBtn', 'saveResBtn'], menuBtn: true, once: true });
  check('320×260: collapse order respected, status shown', [await collapseOrdered(), await pillShown()], [true, true]);
  await page.click('#resMenuBtn');
  check('320×260: the open ⋯ menu shows exactly the collapsed actions, worded like the inline controls', await page.evaluate(() => [...document.querySelectorAll('#resMenu [role^=menuitem]')].filter((b) => b.checkVisibility()).map((b) => b.textContent)), ['Preview', 'Raw', 'Copy', 'Save as file…']);
  check('320×260: Preview / Raw are radio items with the current mode checked', await page.evaluate(() => ['resPreviewItem', 'resRawItem'].map((id) => [document.getElementById(id).getAttribute('role'), document.getElementById(id).getAttribute('aria-checked')])), [['menuitemradio', 'false'], ['menuitemradio', 'true']]);
  await page.click('#resPreviewItem');
  await settle(() => document.querySelector('#resPreview iframe'));
  check('320×260: Preview from the menu switches the body view', await page.evaluate(() => [!!document.querySelector('#resPreview iframe'), document.getElementById('resPreviewItem').getAttribute('aria-checked')]), [true, 'true']);
  await page.click('#resMenuBtn');
  await page.click('#resRawItem');
  await settle(() => !document.getElementById('resBody').hidden);
  await page.click('#viewTabs button[data-view=request]');

  // A narrow request pane (split dragged in the wide layout) keeps the action as an icon with its name in aria-label and title.
  await resize(1024, 320);
  const handle = await page.locator('#splitResizer').boundingBox();
  const split = await page.locator('#split').boundingBox();
  await page.mouse.move(handle.x + 2, handle.y + 40);
  await page.mouse.down();
  await page.mouse.move(split.x + split.width * 0.3, handle.y + 40, { steps: 4 });
  await page.mouse.up();
  await settle(() => document.getElementById('reqPane').clientWidth < 270);
  check('narrow request pane: icon-only Bulk edit with its name', await page.evaluate(() => {
    const b = document.getElementById('bulkBtn');
    return [document.getElementById('reqPane').clientWidth < 270, b.querySelector('.label').checkVisibility(), b.getBoundingClientRect().width <= 30, b.getAttribute('aria-label'), b.title.length > 0];
  }), [true, false, true, 'Bulk edit', true]);
  await page.dblclick('#splitResizer');
  await settle(() => document.getElementById('bulkBtn').querySelector('.label').checkVisibility());
  check('split reset restores the label', await page.evaluate(() => document.getElementById('bulkBtn').querySelector('.label').checkVisibility()), true);

  // The sidebar at its minimum (180 px): both Captured / Saved labels stay, nothing clipped (the
  // small counts here still fit; big ones drop, checked at the end).
  const dragSidebar = async (toX) => {
    const side = await page.locator('#sidebarResizer').boundingBox();
    await page.mouse.move(side.x + 2, side.y + 100);
    await page.mouse.down();
    await page.mouse.move(toX, side.y + 100, { steps: 4 });
    await page.mouse.up();
    await settle(() => document.getElementById('sidebar').clientWidth === 180);
  };
  const listTools = async () => [...await page.evaluate(() => [document.getElementById('sidebar').clientWidth, document.getElementById('capturedCount').checkVisibility(), document.getElementById('collectionCaptured').checkVisibility(), document.getElementById('collectionSaved').checkVisibility()]), await clipped('sidebar', 'listTools')];
  await dragSidebar(100);
  check('minimum sidebar: both tabs stay, nothing clipped', await listTools(), [180, true, true, true, []]);
  await page.dblclick('#sidebarResizer');
  await settle(() => document.getElementById('sidebar').clientWidth === 214);
  check('sidebar reset', (await listTools())[0], 214);

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
  await settle(() => document.querySelector('#requestList li.selected .edited'));
  check('edited captured request shows ● in its row (1024×320)', await page.evaluate(() => { const dot = document.querySelector('#requestList li.selected .edited'); return [!!dot && dot.checkVisibility(), dot?.title]; }), [true, 'Edited — Reset restores the recorded request']);
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
  check('320×260: Captured and Saved tabs both visible, nothing clipped in the list toolbar', [await page.evaluate(() => ['collectionCaptured', 'collectionSaved'].map((id) => document.getElementById(id).checkVisibility())), await clipped('sidebar', 'listTools')], [[true, true], []]);
  await page.evaluate(() => { for (let i = 0; i < 40; i++) __emit(harEntry({ started: `rows-${i}`, url: `http://localhost:8765/rows/${i}`, content: '{}' })); });
  await listHas(41, 'long narrow list');
  check('long list scrolls inside the panel', (await shape()).listScrolls, true);
  await page.evaluate(() => { const list = document.getElementById('requestList'); list.scrollTop = list.scrollHeight; });
  await page.locator('#requestList li[data-id]').last().click();
  match('selecting a row returns to the details', await page.inputValue('#url'), /\/layout\?x=1&keep=kept$/);
  check('draft kept after list → details', (await draft()).body, '{"kept": true}');
  check('narrow row shows ‹ Requests and the path', await page.evaluate(() => [document.getElementById('backBtn').textContent.replace(/\s+/g, ' ').trim(), document.getElementById('contextName').textContent, document.getElementById('contextName').title]), ['Requests 41', '/layout?x=1&keep=kept', 'http://localhost:8765/layout?x=1&keep=kept']);
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
  includes('recorded body (narrow)', await page.textContent('#resBody'), '<h1>recorded</h1>');
  await page.click('#viewTabs button[data-view=request]');
  await page.click('#sendBtn');
  await sendDone();
  check('Send reveals the response', await page.evaluate(() => document.getElementById('app').dataset.view), 'response');
  check('Sent selected after the send', await page.inputValue('#resSource'), 'sent');
  // Recorded and sent both exist now: the selector replaces the label and offers both sources.
  check('source selector with both options once both exist', await page.evaluate(() => [document.getElementById('resSource').checkVisibility(), document.getElementById('resSourceLabel').checkVisibility(), [...document.getElementById('resSource').options].map((o) => [o.value, o.disabled])]), [true, false, [['recorded', false], ['sent', false]]]);
  // The widest combination at the narrowest size: nothing clipped, the collapse order kept and the
  // status still there (time fits with macOS fonts, not necessarily with wider ones).
  await settleActions();
  check('320×260 with the selector: nothing clipped, order respected, status shown', [await clipped('resPane', 'resTabs'), await collapseOrdered(), await pillShown()], [[], true, true]);
  includes('sent body', await page.textContent('#resBody'), '"url": "/layout?x=1&keep=kept"');
  await page.click('#resTabs button[data-tab=resHeaders]');
  const sentHeaders = await page.textContent('#resHeaders');
  ok('sent headers follow the source', sentHeaders.includes('content-type') && !sentHeaders.includes('x-source'), sentHeaders);
  await page.selectOption('#resSource', 'recorded');
  includes('recorded headers after switching the source', await page.textContent('#resHeaders'), 'x-source');
  await page.click('#resTabs button[data-tab=resBody]');
  includes('recorded body after switching the source', await page.textContent('#resBody'), '<h1>recorded</h1>');
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
  check('no status, source or body actions without a response', [await page.textContent('#resStatus'), await page.textContent('#viewResStatus'), await page.isVisible('#resSource'), await page.isVisible('#resSourceLabel'), await page.isVisible('#resMenuBtn'), await page.isVisible('#resCopy')], ['', '', false, false, false, false]);

  // Appearance: Light / Dark / System, persisted with the settings.
  await page.click('#captureBtn');
  await page.click('#appearance button[data-appearance=light]');
  check('light appearance', await page.evaluate(() => document.documentElement.classList.contains('dark')), false);
  check('appearance persisted', (await stored('postcat.settings', (s) => s?.appearance === 'light'))?.appearance, 'light');
  await page.click('#captureBtn');
  await page.click('#appearance button[data-appearance=system]');
  check('system appearance follows DevTools', await page.evaluate(() => document.documentElement.classList.contains('dark')), true);

  // Big counts: shown in the default sidebar; in the minimum one they drop rather than clip, the labels stay.
  await page.evaluate(() => { for (let i = 0; i < 1000; i++) __emit(harEntry({ started: `many-${i}`, url: `http://localhost:8765/many/${i}`, mime: '' })); });
  await page.click('#collectionCaptured');
  await settle(() => document.getElementById('capturedCount').textContent === '1000');
  check('four-digit count in the default sidebar', [await page.textContent('#capturedCount'), ...await listTools()], ['1000', 214, true, true, true, []]);
  await dragSidebar(100);
  await settle(() => !document.getElementById('capturedCount').checkVisibility());
  check('minimum sidebar with big counts: counts drop, both tabs stay', await listTools(), [180, false, true, true, []]);
  await page.dblclick('#sidebarResizer');
  await settle(() => document.getElementById('capturedCount').checkVisibility());
  check('sidebar reset restores the counts', await listTools(), [214, true, true, true, []]);

  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
  check('no uncaught panel errors', errors, []);
  await ctx.close();
  cleanup();
  server.close();
  console.log(`e2e ok (${passed} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
