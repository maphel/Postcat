// Additional DOM-level state and boundary checks. Run with npm run test:qa.
import assert from 'node:assert/strict';
import { buildExtension, launch, openPanel, harEntry, waitForRows } from './harness.js';

let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  console.log(`ok  ${name}`);
  passed++;
}

const extension = buildExtension();
let ctx;
try {
  const launched = await launch(extension.dir);
  ctx = launched.ctx;
  const { page, errors } = await openPanel(ctx, launched.id, { width: 1300, height: 600 });
  const emit = async (o) => {
    await page.evaluate((o) => __emit(harEntry(o)), o);
    await page.waitForFunction((url) => [...document.querySelectorAll('#requestList li[data-id]')].some((li) => li.title.includes(url)), o.url);
    const row = page.locator('#requestList li[data-id]').first();
    const id = await row.getAttribute('data-id');
    await row.click();
    await page.waitForFunction((id) => document.querySelector('#requestList li.selected')?.dataset.id === id, id);
  };
  const menu = async (trigger, item) => { await page.click(trigger); await page.click(item); };
  const search = async (query) => {
    await page.evaluate((query) => window.postcatSearch('performSearch', query), query);
    return page.textContent('#searchCount');
  };
  const matches = () => page.evaluate(() => [...(CSS.highlights.get('postcat-match') || [])].map((range) => range.toString()));

  await emit({ url: 'https://qa.test/unicode', mime: 'text/plain', content: 'İx 😀X x' });
  check('Unicode search uses original DOM offsets after expanding case mappings', await search('x'), '1 / 3');
  check('Unicode search highlights the requested characters', await matches(), ['x', 'X', 'x']);
  check('astral search highlights the complete character', [await search('😀'), await matches()], ['1 / 1', ['😀']]);
  await search('x');
  await page.evaluate(() => window.postcatSearch('previousSearchResult'));
  check('previous search wraps to the last match', await page.textContent('#searchCount'), '3 / 3');
  await page.evaluate(() => window.postcatSearch('nextSearchResult'));
  check('next search wraps to the first match', await page.textContent('#searchCount'), '1 / 3');
  await emit({ url: 'https://qa.test/json', content: '{"key":"Value.*[x]","other":"value"}', resHeaders: [{ name: 'X-Search', value: 'Value' }] });
  check('search spans JSON highlighting nodes', [await search('"key": "Val'), await matches()], ['1 / 1', ['"key": "Val']]);
  check('search treats regex characters as plain text', [await search('.*[x]'), await matches()], ['1 / 1', ['.*[x]']]);
  check('search is case insensitive', await search('VALUE'), '1 / 2');
  await page.click('#resTabs button[data-tab=resHeaders]');
  check('search follows response header tab', await page.textContent('#searchCount'), '1 / 1');
  await page.click('#resTabs button[data-tab=resBody]');
  check('search follows body tab back', await page.textContent('#searchCount'), '1 / 2');
  await emit({ url: 'https://qa.test/search-limit', mime: 'text/plain', content: 'x '.repeat(5001) });
  check('search caps highlights at 5000', [await search('x'), (await matches()).length], ['1 / 5000+', 5000]);
  await page.evaluate(() => window.postcatSearch('cancelSearch'));
  check('cancel search clears both highlight sets', await page.evaluate(() => [document.getElementById('searchCount').hidden, CSS.highlights.has('postcat-match'), CSS.highlights.has('postcat-current')]), [true, false, false]);

  // Real audio metadata exercises minute rollover without touching panel internals.
  const wav = Buffer.alloc(44 + 8000 * 59.6, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await emit({ url: 'https://qa.test/minute.wav', mime: 'audio/wav', content: wav.toString('base64'), encoding: 'base64' });
  await page.waitForFunction(() => document.querySelector('#resPreview .caption')?.textContent.includes('audio/wav'));
  check('audio duration rounds across a minute boundary', (await page.textContent('#resPreview .caption')).split(' · ')[0], '1:00');

  await emit({ url: 'https://qa.test/vector.svg', mime: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3"/></svg>' });
  await page.waitForFunction(() => document.querySelector('#resPreview img')?.naturalWidth === 2);
  check('SVG preview loads without an active-document link', await page.locator('#resPreview a').count(), 0);
  await page.click('#resMode button[data-mode=raw]');
  check('SVG raw preserves source', (await page.textContent('#resBody')).startsWith('<svg '), true);
  await emit({ url: 'https://qa.test/bad.png', mime: 'image/png', content: 'bm90IGEgcG5n', encoding: 'base64' });
  await page.waitForFunction(() => document.querySelector('#resPreview .caption')?.textContent.includes('Couldn’t decode'));
  check('invalid image reports a recoverable preview error', await page.locator('#resMode button[data-mode=raw]').isVisible(), true);
  await emit({ url: 'https://qa.test/bad.woff', mime: 'font/woff', content: 'bm90IGEgZm9udA==', encoding: 'base64' });
  await page.waitForFunction(() => document.getElementById('resPreview').textContent.includes('Couldn’t load this font'));
  check('invalid font reports a recoverable preview error', await page.locator('#resMode button[data-mode=raw]').isVisible(), true);
  await emit({ url: 'https://qa.test/document.pdf', mime: 'application/pdf', content: btoa('%PDF-1.4\n%%EOF'), encoding: 'base64' });
  check('PDF has a titled preview frame', await page.locator('#resPreview iframe').getAttribute('title'), 'PDF preview');

  // Large text takes the cheap rendering paths; recorded bodies are bounded independently.
  for (const length of [310_000, 2_010_000]) {
    await page.evaluate((length) => __emit(harEntry({ url: `https://qa.test/large-${length}`, content: `{"value":"${'x'.repeat(length)}"}` })), length);
    await page.waitForFunction((length) => document.querySelector('#requestList li[data-id]')?.title.includes(`large-${length}`), length);
    await page.locator('#requestList li[data-id]').first().click();
    check(`large JSON ${length} renders without highlighting`, await page.locator('#resBody .j-key').count(), 0);
    check(`large JSON ${length} preserves content`, await page.evaluate((length) => JSON.parse(document.getElementById('resBody').textContent).value.length === length, length), true);
  }
  await page.evaluate(() => __emit(harEntry({ url: 'https://qa.test/recorded-cap', content: 'x'.repeat(20_000_001), mime: 'text/plain' })));
  await page.waitForFunction(() => document.querySelector('#requestList li[data-id]')?.title.includes('recorded-cap'));
  await page.locator('#requestList li[data-id]').first().click();
  check('oversized recorded body is bounded', (await page.textContent('#resBody')).startsWith('Response body too large to keep'), true);

  const beforePause = await page.locator('#requestList li[data-id]').count();
  await page.click('#recordBtn');
  await page.evaluate(() => __emit(harEntry({ url: 'https://qa.test/paused' })));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('paused recording ignores live events', await page.locator('#requestList li[data-id]').count(), beforePause);
  await page.evaluate(() => { window.__har = [harEntry({ url: 'https://qa.test/explicit-import', started: 'import-paused' })]; });
  await menu('#captureBtn', '#importBtn');
  await waitForRows(page, beforePause + 1);
  check('explicit import works while recording is paused', await page.locator('#requestList li[data-id]').count(), beforePause + 1);
  await page.click('#recordBtn');
  await emit({ url: 'https://qa.test/resumed', content: 'resumed' });
  check('recording resumes after pause', await page.textContent('#resBody'), 'resumed');

  // Duplicate is an independent draft. Every captured-list mutation respects its cap.
  const originalId = await page.locator('#requestList li.selected').getAttribute('data-id');
  await menu('#moreBtn', '#dupBtn');
  await page.fill('#url', 'https://qa.test/duplicate-edited');
  await page.waitForFunction(() => document.querySelector('#requestList li.selected')?.title.includes('/duplicate-edited'));
  await page.locator(`#requestList li[data-id="${originalId}"]`).click();
  check('editing a duplicate leaves original intact', await page.inputValue('#url'), 'https://qa.test/resumed');
  await page.evaluate(() => {
    for (let i = 0; i < 1000; i++) __emit(harEntry({ url: `https://qa.test/cap-${i}` }));
  });
  await waitForRows(page, 1000);
  const beforeDuplicate = await page.locator('#requestList li.selected').getAttribute('data-id');
  await menu('#moreBtn', '#dupBtn');
  await page.waitForFunction((id) => document.querySelector('#requestList li.selected')?.dataset.id !== id, beforeDuplicate);
  check('duplicating at the captured cap keeps the cap', await page.locator('#requestList li[data-id]').count(), 1000);
  await menu('#captureBtn', '#clearBtn');
  await waitForRows(page, 0);
  await emit({ url: 'https://qa.test/after-clear', content: 'new' });
  await page.click('#toastAction');
  await waitForRows(page, 1000);
  check('clear, capture and undo keep the cap', await page.locator('#requestList li[data-id]').count(), 1000);
  check('undo keeps the newer selected request', await page.inputValue('#url'), 'https://qa.test/after-clear');
  await menu('#moreBtn', '#deleteBtn');
  await waitForRows(page, 999);
  await emit({ url: 'https://qa.test/after-delete', content: 'newer' });
  await waitForRows(page, 1000);
  await page.click('#toastAction');
  await page.waitForFunction(() => document.querySelector('#requestList li.selected')?.title.includes('/after-clear'));
  check('delete, capture and undo keep the cap', await page.locator('#requestList li[data-id]').count(), 1000);
  check('delete undo restores selection and keeps newer captures', [await page.inputValue('#url'), await page.locator('#requestList li[data-id]').filter({ hasText: '/after-delete' }).count()], ['https://qa.test/after-clear', 1]);

  // Observe clipboard input at the DOM boundary, keeping the machine's clipboard untouched.
  await page.evaluate(() => {
    document.execCommand = (command) => {
      if (command !== 'copy') return false;
      document.body.dataset.copied = document.activeElement.value;
      return true;
    };
  });
  await menu('#moreBtn', '#curlBtn');
  check('Copy as cURL copies the current request', (await page.getAttribute('body', 'data-copied')).includes("curl -X GET 'https://qa.test/after-clear'"), true);
  await page.click('#resCopy');
  check('Copy response copies the current text', await page.getAttribute('body', 'data-copied'), 'new');
  await page.click('#newListBtn');
  await page.fill('#url', 'https://qa.test/edit?keep=yes&drop=no');
  await page.click('#reqTabs button[data-tab=params]');
  await page.locator('#paramsView .kv-row').nth(1).hover();
  await page.locator('#paramsView .kv-row').nth(1).locator('.kv-del').click();
  check('deleting a parameter updates the URL', await page.inputValue('#url'), 'https://qa.test/edit?keep=yes');
  await page.click('#reqTabs button[data-tab=headers]');
  await page.locator('#headersView .kv-row').last().locator('.kv-key').fill('X-QA');
  await page.locator('#headersView .kv-row').first().locator('.kv-value').fill('yes');
  const enabled = page.locator('#headersView .kv-row').first().locator('input[type=checkbox]');
  await enabled.uncheck();
  check('disabling a header removes it from send count', await page.textContent('#reqHeaderCount'), '');
  await enabled.check();
  check('reenabling a header restores the count', await page.textContent('#reqHeaderCount'), '1');
  await page.locator('#headersView .kv-row').first().hover();
  await page.locator('#headersView .kv-row').first().locator('.kv-del').click();
  check('deleting a header leaves an editable blank row', [await page.textContent('#reqHeaderCount'), await page.locator('#headersView .kv-row').count()], ['', 1]);
  await page.fill('#url', 'not a URL');
  await page.press('#url', 'Control+Enter');
  check('send shortcut rejects invalid URLs without entering pending state', [await page.textContent('#toastText'), await page.textContent('#sendBtn')], ['That URL doesn’t look valid.', 'Send']);

  const early = await openPanel(ctx, launched.id, { width: 380, height: 480, init: `
    chrome.storage.local.get = () => new Promise((resolve) => {
      window.__qaFinishLoad = () => resolve({ 'postcat.settings': { xhrOnly: false, tab: 'captured' } });
    });
  ` });
  await early.page.evaluate(() => {
    __emit(harEntry({ url: 'https://qa.test/early.png', type: 'image', mime: 'text/plain', content: 'buffered' }));
    window.__qaFinishLoad();
  });
  await waitForRows(early.page, 1);
  await early.page.locator('#requestList li[data-id]').click();
  await early.page.click('#viewTabs button[data-view=response]');
  check('early captures wait for stored capture preferences', await early.page.textContent('#resBody'), 'buffered');
  check('early capture panel has no uncaught errors', early.errors, []);
  await early.page.close();

  check('no uncaught errors in QA panel', errors, []);
  console.log(`panel QA ok (${passed} checks)`);
} finally {
  await ctx?.close();
  extension.cleanup();
}
