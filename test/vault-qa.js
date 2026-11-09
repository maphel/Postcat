// Collection security and capture consent through the panel DOM and real Chrome storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVault, isVaultRecord, openVault } from '../src/lib/vault.js';
import { buildExtension, launch, openPanel, harEntry, waitForRows, TEST_PASSPHRASE, unlockCollection } from './harness.js';

const SAVED = 'postcat.saved';
const SETTINGS = 'postcat.settings';
const CONSENT = { captureConsent: true };
const AUTH = 'postcat-test-authentication-marker';
const BODY = 'postcat-test-payload-marker';
const URL = 'https://fixture.test/replay?secret=postcat-test-url-marker';
const legacy = [{ name: 'Test request', method: 'POST', url: URL, headersText: `Authorization: Bearer ${AUTH}`, body: BODY }];
const collectionRows = (page) => page.locator('#requestList li[data-id]');
const locked = (page) => page.getByRole('button', { name: 'Unlock collection', exact: true });
const unlocked = (page) => page.getByRole('button', { name: 'Lock collection', exact: true });
const openConsent = (page) => page.locator('#captureConsentDialog[open]').waitFor();

async function fillSetup(page, passphrase = TEST_PASSPHRASE, confirmation = passphrase) {
  await page.fill('#savedPassphrase', passphrase);
  await page.fill('#savedConfirm', confirmation);
  await page.click('#savedSubmit');
}

const setupError = (page) => page.waitForFunction(() => document.getElementById('savedError').textContent.trim() !== '');

async function pasteRequest(page) {
  const command = `curl '${URL}' -X POST -H 'Authorization: Bearer ${AUTH}' --data-raw '${BODY}'`;
  await page.evaluate((command) => {
    const data = new DataTransfer();
    data.setData('text/plain', command);
    document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
  }, command);
}

async function startImport(page) {
  await page.click('#captureBtn');
  await page.click('#importBtn');
}

test('collection vault and recording consent', async (t) => {
  const extension = buildExtension();
  let ctx;
  try {
    const env = await launch(extension.dir);
    ctx = env.ctx;
    const reader = await ctx.newPage();
    await reader.goto(`chrome-extension://${env.id}/src/fixture.html`);
    const read = (key = null) => reader.evaluate(async (key) => {
      const data = await chrome.storage.local.get(key);
      return key == null ? data : data[key];
    }, key);
    const waitStored = async (key, predicate) => {
      const end = Date.now() + 6000;
      do {
        const value = await read(key);
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < end);
      assert.fail(`Timed out waiting for ${key}`);
    };
    const panel = (options = {}) => openPanel(ctx, env.id, { width: 1300, height: 600, ...options });

    await t.test('recording and HAR import wait for affirmative consent', async () => {
      const { page, errors } = await panel({ storage: {} });
      try {
        await page.evaluate(() => {
          window.__qaAccess = { bodies: 0, har: 0 };
          const entry = harEntry({ url: 'https://fixture.test/before-consent', content: '{}' });
          const getContent = entry.getContent;
          entry.getContent = (cb) => { window.__qaAccess.bodies++; getContent(cb); };
          chrome.devtools.network.getHAR = (cb) => {
            window.__qaAccess.har++;
            cb({ entries: [harEntry({ url: 'https://fixture.test/import-after-consent', content: '{}' })] });
          };
          __emit(entry);
        });
        assert.equal(await page.getAttribute('#recordBtn', 'aria-pressed'), 'false');
        assert.equal(await collectionRows(page).count(), 0);
        await startImport(page);
        await openConsent(page);
        await pasteRequest(page);
        assert.equal(await page.locator('#savedDialog[open]').count(), 0);
        assert.equal(await read(SAVED), undefined);
        assert.deepEqual(await page.evaluate(() => window.__qaAccess), { bodies: 0, har: 0 });
        await page.click('#captureConsentCancel');
        await page.locator('#captureConsentDialog[open]').waitFor({ state: 'hidden' });
        assert.notEqual((await read(SETTINGS))?.captureConsent, true);
        assert.deepEqual(await page.evaluate(() => window.__qaAccess), { bodies: 0, har: 0 });
        await startImport(page);
        await openConsent(page);
        await page.click('#captureConsentAccept');
        await waitForRows(page, 1);
        assert.match(await collectionRows(page).first().getAttribute('title'), /import-after-consent/);
        assert.deepEqual(await page.evaluate(() => window.__qaAccess), { bodies: 0, har: 1 });
        await waitStored(SETTINGS, (settings) => settings?.captureConsent === true);
        await page.reload();
        await page.waitForFunction(() => document.getElementById('recordBtn').getAttribute('aria-pressed') === 'true');
        await page.evaluate(() => __emit(harEntry({ url: 'https://fixture.test/live-after-consent', content: '{}' })));
        await waitForRows(page, 1);
        assert.match(await collectionRows(page).first().getAttribute('title'), /live-after-consent/);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });

    await t.test('setup, autosave, locking, reload and wrong-key handling keep secrets encrypted', async () => {
      const { page, errors } = await panel({ storage: { [SETTINGS]: CONSENT } });
      try {
        await page.click('#collectionSaved');
        await page.getByRole('button', { name: 'Set up collection', exact: true }).waitFor();
        await pasteRequest(page);
        await page.locator('#savedDialog[open]').waitFor();
        assert.equal(await read(SAVED), undefined);
        assert.equal(await collectionRows(page).count(), 0);
        await fillSetup(page, TEST_PASSPHRASE, `${TEST_PASSPHRASE} mismatch`);
        await setupError(page);
        assert.equal(await read(SAVED), undefined);
        await fillSetup(page, 'too short');
        await page.waitForFunction(() => document.getElementById('savedError').textContent.includes('at least 16 characters'));
        assert.equal(await read(SAVED), undefined);
        await page.click('#savedCancel');
        await page.locator('#savedDialog[open]').waitFor({ state: 'hidden' });
        assert.equal(await collectionRows(page).count(), 0);
        await pasteRequest(page);
        await fillSetup(page);
        await unlocked(page).waitFor();
        await waitForRows(page, 1);
        assert.equal(await page.inputValue('#url'), URL);
        assert.equal(await page.inputValue('#savedPassphrase'), '');
        assert.equal(await page.inputValue('#savedConfirm'), '');
        const initial = await waitStored(SAVED, (record) => isVaultRecord(record) && record.ciphertext.length > 32);
        const { records } = await openVault(TEST_PASSPHRASE, initial);
        assert.equal(records.length, 1);
        assert.equal(records[0].url, URL);
        assert.equal(records[0].method, 'POST');
        assert.match(records[0].headersText, new RegExp(AUTH));
        assert.equal(records[0].body, BODY);

        await page.click('#reqTabs button[data-tab=body]');
        await page.fill('#body', `${BODY}-updated`);
        await page.fill('#filterInput', AUTH);
        await unlocked(page).click();
        await locked(page).waitFor();
        assert.equal(await page.inputValue('#url'), '');
        assert.equal(await page.inputValue('#body'), '');
        assert.equal(await collectionRows(page).count(), 0);
        const final = await waitStored(SAVED, (record) => isVaultRecord(record) && record.iv !== initial.iv);
        const updated = await openVault(TEST_PASSPHRASE, final);
        assert.equal(updated.records[0].body, `${BODY}-updated`);
        const atRest = JSON.stringify(await read());
        for (const secret of [AUTH, BODY, URL, TEST_PASSPHRASE]) assert.equal(atRest.includes(secret), false);
        assert.deepEqual(Object.keys(final).sort(), ['ciphertext', 'iv', 'salt', 'version']);

        await page.click('#collectionCaptured');
        await page.fill('#filterInput', '');
        await page.evaluate(() => __emit(harEntry({ url: 'https://fixture.test/capture-while-locked', content: '{}' })));
        await waitForRows(page, 1);
        assert.match(await collectionRows(page).first().getAttribute('title'), /capture-while-locked/);
        await page.reload();
        await page.click('#collectionSaved');
        await locked(page).waitFor();
        assert.equal(await page.inputValue('#filterInput'), '');
        assert.equal(await collectionRows(page).count(), 0);
        await locked(page).click();
        await page.fill('#savedPassphrase', 'incorrect but long test passphrase');
        await page.click('#savedSubmit');
        await setupError(page);
        assert.equal(await collectionRows(page).count(), 0);
        assert.deepEqual(await read(SAVED), final);
        await page.fill('#savedPassphrase', TEST_PASSPHRASE);
        await page.click('#savedSubmit');
        await unlocked(page).waitFor();
        await waitForRows(page, 1);
        await collectionRows(page).first().click();
        assert.equal(await page.inputValue('#url'), URL);
        assert.equal(await page.inputValue('#body'), `${BODY}-updated`);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });

    await t.test('failed legacy migration preserves the original and retry encrypts it', async () => {
      const { page, errors } = await panel({ storage: { [SAVED]: legacy, [SETTINGS]: { ...CONSENT, filterText: AUTH } }, init: `
        const set = chrome.storage.local.set.bind(chrome.storage.local);
        window.__qaRejectVaultWrite = true;
        chrome.storage.local.set = (items) => {
          if (window.__qaRejectVaultWrite && 'postcat.saved' in items) return Promise.reject(new Error('Resource::kQuotaBytes quota exceeded'));
          return set(items);
        };
      ` });
      try {
        await page.click('#collectionSaved');
        await page.getByRole('button', { name: 'Set up collection', exact: true }).click();
        assert.equal(await collectionRows(page).count(), 0);
        assert.equal(await page.inputValue('#filterInput'), '');
        await fillSetup(page);
        await setupError(page);
        assert.match(await page.textContent('#savedError'), /storage limit.*original was kept/i);
        assert.deepEqual(await read(SAVED), legacy);
        assert.equal(await collectionRows(page).count(), 0);
        await page.evaluate(() => { window.__qaRejectVaultWrite = false; });
        await fillSetup(page);
        await unlocked(page).waitFor();
        await waitForRows(page, 1);
        const migrated = await waitStored(SAVED, isVaultRecord);
        assert.deepEqual((await openVault(TEST_PASSPHRASE, migrated)).records, legacy);
        await waitStored(SETTINGS, (settings) => settings && !Object.hasOwn(settings, 'filterText'));
        assert.equal(JSON.stringify(await read()).includes(AUTH), false);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });

    await t.test('malformed or unreadable vaults are kept intact', async () => {
      const { record } = await createVault(TEST_PASSPHRASE, legacy);
      const originalSettings = { captureConsent: true, appearance: 'light' };
      for (const [value, init] of [
        [{ ...record, iv: 'invalid' }, ''],
        [record, `chrome.storage.local.get = async () => { throw new Error('fixture storage offline'); };`],
      ]) {
        const { page, errors } = await panel({ storage: { [SAVED]: value, [SETTINGS]: originalSettings }, init });
        try {
          await page.click('#collectionSaved');
          await page.getByText(init ? 'Saved collection unavailable' : 'Saved collection unreadable', { exact: true }).waitFor();
          assert.equal(await collectionRows(page).count(), 0);
          await pasteRequest(page);
          assert.equal(await page.locator('#savedDialog[open]').count(), 0);
          assert.equal(await collectionRows(page).count(), 0);
          assert.equal(await page.inputValue('#url'), '');
          assert.deepEqual(await read(SAVED), value);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
        assert.deepEqual(await read(SAVED), value);
        if (init) assert.deepEqual(await read(SETTINGS), originalSettings);
      }
    });

    await t.test('the save indicator follows pending, failed and retried encrypted writes', async () => {
      const { record } = await createVault(TEST_PASSPHRASE, legacy);
      const { page, errors } = await panel({ storage: { [SAVED]: record, [SETTINGS]: CONSENT }, init: `
        const set = chrome.storage.local.set.bind(chrome.storage.local);
        window.__qaHoldWrite = true;
        window.__qaFailWrite = true;
        chrome.storage.local.set = async (items) => {
          if ('postcat.saved' in items) {
            if (window.__qaHoldWrite) {
              window.__qaHoldWrite = false;
              await new Promise((resolve) => { window.__qaResumeWrite = resolve; });
            }
            if (window.__qaFailWrite) throw new Error('fixture encrypted write failed');
          }
          return set(items);
        };
      ` });
      try {
        const closeWouldPrompt = () => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
        const waitForPendingWrite = async () => {
          await page.waitForFunction(() => typeof window.__qaResumeWrite === 'function');
          assert.equal(await page.textContent('#savedWriteStatus'), 'Saving…');
          assert.equal(await page.isVisible('#savedWriteStatus'), true);
          assert.equal(await closeWouldPrompt(), true);
          assert.deepEqual(await read(SAVED), record);
        };
        await unlockCollection(page);
        await waitForRows(page, 1);
        await collectionRows(page).first().click();
        const unsaved = 'https://fixture.test/unsaved-draft';
        await page.fill('#url', unsaved);
        await waitForPendingWrite();
        await page.evaluate(() => window.__qaResumeWrite());
        await page.waitForFunction(() => document.getElementById('toastText').textContent.includes('fixture encrypted write failed'));
        assert.equal(await page.textContent('#savedWriteStatus'), 'Unsaved changes');
        assert.equal(await page.isVisible('#savedWriteStatus'), true);
        assert.deepEqual(await read(SAVED), record);
        await unlocked(page).click();
        await page.waitForFunction(() => document.getElementById('toastText').textContent.includes('while edits are unsaved'));
        await unlocked(page).waitFor();
        assert.equal(await page.inputValue('#url'), unsaved);
        assert.equal(await page.textContent('#savedWriteStatus'), 'Unsaved changes');
        assert.deepEqual(await read(SAVED), record);

        await page.evaluate(() => {
          window.__qaHoldWrite = true;
          window.__qaFailWrite = false;
          window.__qaResumeWrite = null;
        });
        await page.press('#url', 'Control+s');
        await waitForPendingWrite();
        await page.evaluate(() => window.__qaResumeWrite());
        await page.waitForFunction(() => document.getElementById('savedWriteStatus').textContent === '');
        assert.equal(await closeWouldPrompt(), false);
        const saved = await read(SAVED);
        assert.equal((await openVault(TEST_PASSPHRASE, saved)).records[0].url, unsaved);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });

    await t.test('a stale panel cannot replace a newer encrypted save', async () => {
      const { record } = await createVault(TEST_PASSPHRASE, legacy);
      const a = await panel({ storage: { [SAVED]: record, [SETTINGS]: CONSENT } });
      const b = await panel();
      try {
        for (const { page } of [a, b]) {
          await unlockCollection(page);
          await waitForRows(page, 1);
          await collectionRows(page).first().click();
        }
        const updatedURL = 'https://fixture.test/newer-window';
        await a.page.fill('#url', updatedURL);
        const newer = await waitStored(SAVED, (value) => isVaultRecord(value) && value.iv !== record.iv);
        assert.equal((await openVault(TEST_PASSPHRASE, newer)).records[0].url, updatedURL);
        const staleURL = 'https://fixture.test/stale-window';
        await b.page.fill('#url', staleURL);
        await b.page.waitForFunction(() => document.getElementById('toastText').textContent.includes('changed in another panel'));
        assert.equal(await b.page.inputValue('#url'), staleURL);
        assert.deepEqual(await read(SAVED), newer);
        assert.deepEqual([...a.errors, ...b.errors], []);
      } finally {
        await a.page.close();
        await b.page.close();
      }
    });
  } finally {
    await ctx?.close();
    extension.cleanup();
  }
});
