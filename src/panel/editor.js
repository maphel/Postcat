// The request editor: the narrow navigation row, URL bar, params/headers/body tabs, status line.
import { parseHeaders, textToRows, rowsToText, urlToParams, paramsToUrl, jsonError, expectsJson } from '../lib/index.js';
import { state, current, isEdited, defaultName, METHODS } from './state.js';
import { persistSavedSoon } from './storage.js';
import { $ } from './dom.js';
import { createKvEditor } from './kv-editor.js';
import { renderList } from './list.js';
import { renderResponse } from './response.js';
import { applyScreen } from './layout.js';

// Called after any edit of the current item: autosave, counters, list badges.
export function afterEdit(item) {
  if (item.kind === 'saved') persistSavedSoon();
  renderEditState();
  renderList();
}

export const paramsKv = createKvEditor($('paramsView'), {
  toggles: false,
  keyPlaceholder: 'Key',
  valuePlaceholder: 'Value',
  onChange(rows) {
    const item = current();
    if (!item) return;
    item.url = paramsToUrl(item.url, rows);
    $('url').value = item.url;
    afterEdit(item);
  },
});

export const headersKv = createKvEditor($('headersView'), {
  toggles: true,
  keyPlaceholder: 'Header',
  valuePlaceholder: 'Value',
  onChange(rows) {
    const item = current();
    if (!item) return;
    item.headersText = rowsToText(rows);
    afterEdit(item);
  },
});

export function renderEditor() {
  const item = current();
  $('emptyState').hidden = !!item;
  $('editor').hidden = !item;
  applyScreen();
  if (!item) return;

  const select = $('method');
  const methods = METHODS.includes(item.method) ? METHODS : [...METHODS, item.method];
  select.replaceChildren(...methods.map((m) => new Option(m, m)));
  select.value = item.method;
  select.className = `m-${item.method.toLowerCase()}`;
  $('url').value = item.url;
  renderContextName();

  const saved = item.kind === 'saved';
  // Saved items autosave: the bookmark stays (filled) so the row keeps its shape, but does nothing.
  const saveBtn = $('saveBtn');
  saveBtn.disabled = saved;
  saveBtn.classList.toggle('saved', saved);
  saveBtn.title = saved ? 'In your collection · changes are saved automatically' : 'Save to collection (⌘/Ctrl + S)';
  saveBtn.setAttribute('aria-label', saved ? 'Saved to collection' : 'Save to collection');

  paramsKv.set(urlToParams(item.url));
  headersKv.set(textToRows(item.headersText));
  $('headers').value = item.headersText;
  $('body').value = item.body;

  renderReqTab();
  renderEditState();
  renderResponse();
}

// The narrow layout's navigation row: the saved name, or the path of a captured request (the
// full URL in its title). Read-only; saved names are edited in the list row (list.js).
export function renderContextName() {
  const item = current();
  if (!item) return;
  const name = $('contextName');
  name.textContent = item.kind === 'saved' ? item.name || defaultName(item) : pathOf(item.url);
  name.title = item.url;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function renderReqTab() {
  const tab = state.reqTab;
  for (const b of $('reqTabs').querySelectorAll('button[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('paramsView').hidden = tab !== 'params';
  $('headersView').hidden = tab !== 'headers' || state.bulkHeaders;
  $('headers').hidden = tab !== 'headers' || !state.bulkHeaders;
  $('body').hidden = tab !== 'body';
  // One contextual action per tab (none on Params): Bulk edit / Table view on Headers, Beautify on Body.
  const bulk = $('bulkBtn');
  bulk.hidden = tab !== 'headers';
  bulk.querySelector('.label').textContent = state.bulkHeaders ? 'Table view' : 'Bulk edit';
  bulk.setAttribute('aria-label', state.bulkHeaders ? 'Table view' : 'Bulk edit');
  bulk.title = state.bulkHeaders ? 'Edit the headers in a table' : 'Edit the headers as plain text';
  $('bulkIcon').setAttribute('href', state.bulkHeaders ? '#i-table' : '#i-lines');
  $('beautifyBtn').hidden = tab !== 'body';
  const item = current();
  if (item) renderBodyStatus(item);
}

// Cheap per-keystroke updates: counters, edited markers, reset button.
function renderEditState() {
  const item = current();
  if (!item) return;
  $('reqParamCount').textContent = urlToParams(item.url).length || '';
  $('reqHeaderCount').textContent = parseHeaders(item.headersText).length || '';
  renderBodyStatus(item);
  const edited = isEdited(item);
  $('resetBtn').hidden = !edited;
  $('renameBtn').hidden = item.kind !== 'saved';
  $('viewEdited').hidden = !edited;
  $('method').className = `m-${item.method.toLowerCase()}`;
}

function renderBodyStatus(item) {
  const mark = $('reqBodyMark');
  const status = $('bodyStatus');
  const contentType = parseHeaders(item.headersText).find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  const multipart = item.body && /multipart\/form-data/i.test(contentType);
  const error = expectsJson(item.body, item.headersText) ? jsonError(item.body) : undefined;
  mark.textContent = item.body ? '●' : '';
  mark.className = `dotmark ${error ? 'bad' : multipart ? 'warn' : ''}`;
  mark.title = error ? 'Body is not valid JSON' : multipart ? 'Multipart body: file parts may not replay byte-exact' : '';
  status.hidden = state.reqTab !== 'body' || (error === undefined && !multipart);
  if (multipart && error === undefined) {
    status.className = 'status-line warn';
    status.textContent = '⚠ Multipart form data: text fields replay fine, binary file parts may be altered (DevTools records them as text).';
    status.title = status.textContent;
    return;
  }
  if (error === undefined) return;
  status.className = `status-line ${error ? 'bad' : 'ok'}`;
  status.textContent = error ? `✕ Invalid JSON — line ${error.line}, column ${error.column}: ${error.message}` : '✓ Valid JSON';
  status.title = status.textContent;
}
