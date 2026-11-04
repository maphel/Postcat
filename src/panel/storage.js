// chrome.storage.local: the saved collection and the panel settings.
import { state, nextId, DEFAULT_LAYOUT, LAYOUT_LIMITS, APPEARANCES } from './state.js';
import { toast } from './dom.js';

const SAVED_KEY = 'postcat.saved';
const SETTINGS_KEY = 'postcat.settings';
let storageLoaded = false;

// Everything read back is validated: one corrupt record must not break the panel.
export async function loadStorage() {
  let data;
  try {
    data = await chrome.storage.local.get([SAVED_KEY, SETTINGS_KEY]);
    storageLoaded = true;
  } catch (err) {
    toast(`Couldn’t load saved requests: ${err?.message || err}`);
    data = {};
  }
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  state.saved = (Array.isArray(data[SAVED_KEY]) ? data[SAVED_KEY] : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: nextId(),
      kind: 'saved',
      name: str(item.name),
      method: str(item.method, 'GET').toUpperCase() || 'GET',
      url: str(item.url),
      headersText: str(item.headersText),
      body: str(item.body),
    }));
  const s = data[SETTINGS_KEY] || {};
  if (typeof s.xhrOnly === 'boolean') state.xhrOnly = s.xhrOnly;
  if (typeof s.bulkHeaders === 'boolean') state.bulkHeaders = s.bulkHeaders;
  if (['captured', 'saved'].includes(s.tab)) state.tab = s.tab;
  if (['params', 'headers', 'body'].includes(s.reqTab)) state.reqTab = s.reqTab;
  if (typeof s.filterText === 'string') state.filterText = s.filterText;
  if (APPEARANCES.includes(s.appearance)) state.appearance = s.appearance;
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  state.layout = {
    sidebarW: Math.max(LAYOUT_LIMITS.sidebarMin, num(s.layout?.sidebarW, DEFAULT_LAYOUT.sidebarW)),
    reqW: Math.max(LAYOUT_LIMITS.reqMin, Math.min(LAYOUT_LIMITS.reqMax, num(s.layout?.reqW, DEFAULT_LAYOUT.reqW))),
  };
}

let savedTimer = 0;
export function persistSavedSoon() {
  clearTimeout(savedTimer);
  savedTimer = setTimeout(persistSaved, 400);
}

export function persistSaved() {
  clearTimeout(savedTimer);
  savedTimer = 0;
  const plain = state.saved.map(({ name, method, url, headersText, body }) => ({ name, method, url, headersText, body }));
  return write({ [SAVED_KEY]: plain });
}

// A rejected write (quota exhausted, storage unavailable) would otherwise stop autosave silently.
async function write(items) {
  if (!storageLoaded) {
    toast('Couldn’t save: saved requests haven’t loaded. Reopen DevTools to retry.');
    return false;
  }
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
  if (!storageLoaded) return; // Never replace settings that could not be read.
  const { xhrOnly, bulkHeaders, tab, reqTab, filterText, layout, appearance } = state;
  return write({ [SETTINGS_KEY]: { xhrOnly, bulkHeaders, tab, reqTab, filterText, layout, appearance } });
}

// Debounced writes still pending when DevTools closes.
export function flushPending() {
  if (savedTimer) persistSaved();
  if (settingsTimer) {
    clearTimeout(settingsTimer);
    writeSettings();
  }
}
