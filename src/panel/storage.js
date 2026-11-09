// chrome.storage.local: the encrypted collection and the panel settings.
import { state, nextId, DEFAULT_LAYOUT, LAYOUT_LIMITS, APPEARANCES } from './state.js';
import { $, toast } from './dom.js';
import { createVault, isVaultRecord, openVault, sealVault } from '../lib/vault.js';

const SAVED_KEY = 'postcat.saved';
const SETTINGS_KEY = 'postcat.settings';
const SAVED_WRITE_LOCK = 'postcat.saved.write';
export const SAVED_PASSPHRASE_MIN = 16;
let lockedStatus = 'loading';
let savedRecord;
let vaultKey = null;
let savedRevision = 0;
let writtenRevision = 0;
let pendingWrites = Promise.resolve(true);

function savedRecordStatus(record) {
  if (record === undefined) return 'new';
  if (Array.isArray(record)) return 'legacy';
  return isVaultRecord(record) ? 'locked' : 'corrupt';
}

export function savedStatus() {
  return vaultKey ? 'unlocked' : lockedStatus;
}

// Legacy arrays and authenticated plaintext both pass the same record validation.
function readRecords(records) {
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  return records
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      name: str(item.name),
      method: str(item.method, 'GET').toUpperCase() || 'GET',
      url: str(item.url),
      headersText: str(item.headersText),
      body: str(item.body),
    }));
}

// Everything read back is validated: one corrupt record must not break the panel.
export async function loadStorage() {
  let data;
  try {
    data = await chrome.storage.local.get([SAVED_KEY, SETTINGS_KEY]);
  } catch (err) {
    lockedStatus = 'unavailable';
    toast(`Couldn’t load saved requests: ${err?.message || err}`);
    return;
  }
  lockedStatus = savedRecordStatus(data[SAVED_KEY]);
  const s = data[SETTINGS_KEY] || {};
  state.captureConsent = s.captureConsent === true;
  if (typeof s.xhrOnly === 'boolean') state.xhrOnly = s.xhrOnly;
  if (typeof s.bulkHeaders === 'boolean') state.bulkHeaders = s.bulkHeaders;
  if (['captured', 'saved'].includes(s.tab)) state.tab = s.tab;
  if (['params', 'headers', 'body'].includes(s.reqTab)) state.reqTab = s.reqTab;
  if (APPEARANCES.includes(s.appearance)) state.appearance = s.appearance;
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  state.layout = {
    sidebarW: Math.max(LAYOUT_LIMITS.sidebarMin, num(s.layout?.sidebarW, DEFAULT_LAYOUT.sidebarW)),
    reqW: Math.max(LAYOUT_LIMITS.reqMin, Math.min(LAYOUT_LIMITS.reqMax, num(s.layout?.reqW, DEFAULT_LAYOUT.reqW))),
  };
}

function sameRecord(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
  }
  // The expected envelope was already validated. Equal fields imply equal validated bytes.
  return a && b && a.version === b.version && a.salt === b.salt && a.iv === b.iv
    && a.ciphertext === b.ciphertext && Object.keys(a).length === Object.keys(b).length;
}

// Compare inside the shared lock. A second panel can read the vault but cannot silently
// replace a collection that has changed since it was opened.
async function replaceRecord(expected, next) {
  await navigator.locks.request(SAVED_WRITE_LOCK, async () => {
    const latest = (await chrome.storage.local.get(SAVED_KEY))[SAVED_KEY];
    if (!sameRecord(latest, expected)) {
      throw new Error('Saved requests changed in another panel. Reopen DevTools to load them again.');
    }
    await chrome.storage.local.set({ [SAVED_KEY]: next });
    savedRecord = next;
  });
}

export async function unlockSaved(passphrase, expectedStatus) {
  if (lockedStatus === 'loading' || lockedStatus === 'unavailable') {
    throw new Error('Saved requests haven’t loaded. Reopen DevTools to retry.');
  }
  if (vaultKey) return;
  const record = (await chrome.storage.local.get(SAVED_KEY))[SAVED_KEY];
  const status = savedRecordStatus(record);
  if (status !== expectedStatus) {
    lockedStatus = status;
    throw new Error('Saved requests changed in another panel. Close this prompt and try again.');
  }
  let key;
  let records;
  if (status === 'corrupt') throw new Error('The stored collection is damaged or uses an unsupported format.');
  if (status === 'locked') {
    try {
      const opened = await openVault(passphrase, record);
      key = opened.key;
      records = readRecords(opened.records);
      savedRecord = record;
    } catch {
      throw new Error('Couldn’t unlock saved requests. Check the passphrase and try again.');
    }
  } else {
    if (Array.from(passphrase).length < SAVED_PASSPHRASE_MIN) {
      throw new Error(`Use a passphrase of at least ${SAVED_PASSPHRASE_MIN} characters.`);
    }
    records = status === 'legacy' ? readRecords(record) : [];
    const created = await createVault(passphrase, records);
    // Replace the legacy value only after encryption succeeds. A failed write leaves it intact.
    try {
      await replaceRecord(record, created.record);
    } catch (err) {
      if (status === 'legacy' && /quota/i.test(err?.message || '')) {
        throw new Error('The encrypted collection exceeds Chrome’s storage limit. The original was kept. Reduce it in your previous Postcat version and retry.', { cause: err });
      }
      throw err;
    }
    key = created.key;
  }
  state.saved = records.map((item) => ({ id: nextId(), kind: 'saved', ...item }));
  lockedStatus = 'locked';
  vaultKey = key;
}

function warnBeforeClosing(event) {
  event.preventDefault();
  event.returnValue = '';
}

function setWriteStatus(text) {
  $('savedWriteStatus').textContent = text;
  // Chrome can warn on ordinary DevTools close after a user interaction.
  if (text) window.addEventListener('beforeunload', warnBeforeClosing);
  else window.removeEventListener('beforeunload', warnBeforeClosing);
}

function queueSavedWrite() {
  setWriteStatus('Saving…');
  pendingWrites = pendingWrites.then(async () => {
    if (savedRevision === writtenRevision) return true;
    const revision = savedRevision;
    const plain = state.saved.map(({ name, method, url, headersText, body }) => ({ name, method, url, headersText, body }));
    const expected = savedRecord;
    const encrypted = await sealVault(vaultKey, expected.salt, plain);
    await replaceRecord(expected, encrypted);
    writtenRevision = revision;
    return true;
  }).then((saved) => {
    if (savedRevision === writtenRevision) setWriteStatus('');
    return saved;
  }).catch((err) => {
    setWriteStatus('Unsaved changes');
    toast(`Couldn’t save: ${err?.message || err}`);
    return false;
  });
  return pendingWrites;
}

// Begin encryption promptly. Writes queued during encryption take the latest snapshot;
// once that revision is on disk, duplicate queued writes do nothing.
export function persistSaved() {
  if (!vaultKey) {
    toast('Unlock saved requests before saving.');
    return Promise.resolve(false);
  }
  savedRevision++;
  return queueSavedWrite();
}

export async function lockSaved() {
  if (!vaultKey) return [];
  while (savedRevision !== writtenRevision) {
    if (!await queueSavedWrite()) throw new Error('Couldn’t lock the collection while edits are unsaved.');
  }
  const removedIds = state.saved.map((item) => item.id);
  state.saved = [];
  vaultKey = null;
  savedRecord = undefined;
  return removedIds;
}

// A rejected write (quota exhausted, storage unavailable) must stay visible.
async function writeSettingsValue(items) {
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch (err) {
    toast(`Couldn’t save: ${err?.message || err}`);
    return false;
  }
}

let settingsTimer = 0;
export function persistSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(writeSettings, 300);
}

function writeSettings() {
  settingsTimer = 0;
  if (lockedStatus === 'loading' || lockedStatus === 'unavailable') return;
  const { captureConsent, xhrOnly, bulkHeaders, tab, reqTab, layout, appearance } = state;
  // A filter can contain a URL or token, so it stays in the current panel's memory.
  return writeSettingsValue({ [SETTINGS_KEY]: { captureConsent, xhrOnly, bulkHeaders, tab, reqTab, layout, appearance } });
}

// Flush settings still pending when DevTools closes. Encrypted writes start when edited.
export function flushPending() {
  if (settingsTimer) {
    clearTimeout(settingsTimer);
    writeSettings();
  }
}
