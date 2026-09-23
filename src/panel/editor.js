// The request editor: URL bar, params/headers/body tabs, status line.
import { parseHeaders, textToRows, rowsToText, urlToParams, paramsToUrl, formatTime, jsonError, expectsJson } from '../lib/index.js';
import { state, current, isEdited, METHODS } from './state.js';
import { persistSavedSoon } from './storage.js';
import { $, el } from './dom.js';
import { createKvEditor } from './kv-editor.js';
import { renderList } from './list.js';
import { renderResponse } from './response.js';

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
  if (!item) return;

  const select = $('method');
  const methods = METHODS.includes(item.method) ? METHODS : [...METHODS, item.method];
  select.replaceChildren(...methods.map((m) => new Option(m, m)));
  select.value = item.method;
  select.className = `m-${item.method.toLowerCase()}`;
  $('url').value = item.url;

  const saved = item.kind === 'saved';
  $('name').hidden = !saved;
  $('name').value = item.name || '';
  $('info').hidden = saved;
  $('saveBtn').hidden = saved; // saved items autosave

  paramsKv.set(urlToParams(item.url));
  headersKv.set(textToRows(item.headersText));
  $('headers').value = item.headersText;
  $('body').value = item.body;

  renderReqTab();
  renderEditState();
  renderResponse();
}

export function renderReqTab() {
  const tab = state.reqTab;
  for (const b of $('reqTabs').querySelectorAll('button[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  $('paramsView').hidden = tab !== 'params';
  $('headersView').hidden = tab !== 'headers' || state.bulkHeaders;
  $('headers').hidden = tab !== 'headers' || !state.bulkHeaders;
  $('body').hidden = tab !== 'body';
  $('bulkBtn').hidden = tab !== 'headers';
  $('bulkBtn').textContent = state.bulkHeaders ? 'Table view' : 'Bulk edit';
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
  $('resetBtn').hidden = !isEdited(item);
  $('method').className = `m-${item.method.toLowerCase()}`;

  if (item.kind === 'captured') {
    const info = $('info');
    const date = new Date(item.startedDateTime);
    const parts = [Number.isNaN(date.getTime()) ? 'Captured' : `Captured ${date.toLocaleTimeString()}`];
    if (item.resourceType) parts.push(item.resourceType);
    if (item.recorded?.time != null) parts.push(formatTime(item.recorded.time));
    info.replaceChildren(parts.join(' · '));
    if (isEdited(item)) info.append(' · ', el('span', 'edited-tag', 'edited'));
  }
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
