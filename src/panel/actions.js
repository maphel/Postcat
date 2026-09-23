// User actions that change what's selected or which items exist.
import { headersToText, toCurl, parseCurl, compileFilter } from '../lib/index.js';
import { state, lists, current, visibleItems, copyOf, defaultName, nextId } from './state.js';
import { persistSaved, persistSettings } from './storage.js';
import { $, toast, copyText } from './dom.js';
import { renderList } from './list.js';
import { renderEditor } from './editor.js';
import { clamp } from './layout.js';
import { requestOf, abandonSend } from './sending.js';

export function select(id) {
  state.selectedId = id;
  renderEditor();
  renderList({ scroll: true });
}

export async function save() {
  const item = current();
  if (!item) return;
  if (item.kind === 'saved') {
    await persistSaved();
    toast('Saved');
    return;
  }
  const copy = copyOf(item, 'saved');
  state.saved.unshift(copy);
  await persistSaved();
  switchTab('saved');
  select(copy.id);
  toast('Saved to collection');
  $('name').select();
}

export async function duplicate() {
  const item = current();
  if (!item) return;
  const copy = copyOf(item, item.kind);
  if (item.kind === 'saved') copy.name = `${copy.name} (copy)`;
  if (item.kind === 'captured') {
    copy.name = '';
    copy.startedDateTime = item.startedDateTime;
  }
  const list = lists()[item.kind];
  list.splice(list.indexOf(item), 0, copy);
  if (item.kind === 'saved') await persistSaved();
  select(copy.id);
  toast('Duplicated');
}

export function reset() {
  const item = current();
  if (!item?.original) return;
  Object.assign(item, item.original);
  abandonSend(item.id);
  state.responses.delete(item.id);
  renderEditor();
  renderList();
}

export function moveSelection(delta) {
  const ids = visibleItems().map((i) => i.id);
  if (!ids.length) return;
  const idx = ids.indexOf(state.selectedId);
  const next = idx === -1 ? (delta > 0 ? 0 : ids.length - 1) : clamp(idx + delta, 0, ids.length - 1);
  select(ids[next]);
}

export function remove() {
  const item = current();
  if (!item) return;
  const ids = visibleItems().map((i) => i.id);
  const pos = ids.indexOf(item.id);
  const neighbour = ids[pos + 1] ?? ids[pos - 1] ?? null;

  const list = lists()[item.kind];
  const index = list.indexOf(item);
  list.splice(index, 1);
  const response = abandonSend(item.id);
  state.responses.delete(item.id);
  if (item.kind === 'saved') persistSaved();
  select(neighbour);

  toast(`Deleted ${item.kind === 'saved' ? `“${item.name || defaultName(item)}”` : 'request'}`, {
    label: 'Undo',
    run() {
      const target = lists()[item.kind];
      target.splice(Math.min(index, target.length), 0, item);
      if (response) state.responses.set(item.id, response);
      if (item.kind === 'saved') persistSaved();
      switchTab(item.kind);
      select(item.id);
    },
  });
}

export function clearCaptured() {
  if (!state.captured.length) return;
  const cleared = state.captured;
  const selectedBefore = state.selectedId;
  const responses = new Map();
  for (const item of cleared) {
    const response = abandonSend(item.id);
    if (response) responses.set(item.id, response);
    state.responses.delete(item.id);
  }
  state.captured = [];
  // `seen` stays: "Import log" must not bring back what was just cleared.
  if (current()?.kind === 'captured' || !current()) select(null);
  else renderList();
  toast(`Cleared ${cleared.length} request${cleared.length === 1 ? '' : 's'}`, {
    label: 'Undo',
    run() {
      state.captured = [...state.captured, ...cleared];
      for (const [id, response] of responses) state.responses.set(id, response);
      switchTab('captured');
      if (state.selectedId === null && cleared.some((i) => i.id === selectedBefore)) select(selectedBefore);
    },
  });
}

export function copyCurl() {
  const item = current();
  if (item) copyText(toCurl(requestOf(item)), 'cURL copied');
}

// `from` is a parsed cURL command; without it an empty request is created.
export function newRequest(from) {
  const item = {
    id: nextId(),
    kind: 'saved',
    name: from ? defaultName(from) : 'New request',
    method: from?.method || 'GET',
    url: from?.url || '',
    headersText: from ? headersToText(from.headers) : '',
    body: from?.body || '',
  };
  state.saved.unshift(item);
  persistSaved();
  setFilter('');
  switchTab('saved');
  select(item.id);
  if (!from) $('url').focus();
  return item;
}

// null: not a curl command; false: a curl command we couldn't read; else the parsed request.
export function tryParseCurl(text) {
  if (!/^\s*curl\s/i.test(text)) return null;
  try {
    const parsed = parseCurl(text);
    return parsed?.url ? parsed : false;
  } catch {
    return false;
  }
}

export function switchTab(tab) {
  state.tab = tab;
  for (const b of $('listTabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  renderList();
  persistSettings();
}

export function setFilter(text) {
  state.filterText = text;
  state.filter = compileFilter(text);
  $('filterInput').value = text;
  renderList();
  persistSettings();
}

export function setRecording(on) {
  state.recording = on;
  $('recordBtn').classList.toggle('on', on);
  $('recordLabel').textContent = on ? 'Recording' : 'Paused';
  renderList();
}
