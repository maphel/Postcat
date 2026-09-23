// chrome.storage.local: the saved collection and the panel settings.
import { state, nextId, DEFAULT_LAYOUT } from './state.js';

const SAVED_KEY = 'postcat.saved';
const SETTINGS_KEY = 'postcat.settings';

// Everything read back is validated: one corrupt record must not break the panel.
export async function loadStorage() {
  const data = await chrome.storage.local.get([SAVED_KEY, SETTINGS_KEY]);
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
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  state.layout = {
    sidebarW: num(s.layout?.sidebarW, DEFAULT_LAYOUT.sidebarW),
    reqW: num(s.layout?.reqW, DEFAULT_LAYOUT.reqW),
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
  return chrome.storage.local.set({ [SAVED_KEY]: plain });
}

let settingsTimer = 0;
export function persistSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(writeSettings, 300);
}

function writeSettings() {
  settingsTimer = 0;
  const { xhrOnly, bulkHeaders, tab, reqTab, filterText, layout } = state;
  return chrome.storage.local.set({ [SETTINGS_KEY]: { xhrOnly, bulkHeaders, tab, reqTab, filterText, layout } });
}

// Debounced writes still pending when DevTools closes.
export function flushPending() {
  if (savedTimer) persistSaved();
  if (settingsTimer) {
    clearTimeout(settingsTimer);
    writeSettings();
  }
}
