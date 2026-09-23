// The request list on the left: compact single-line rows (method, name or path, status).
import { formatTime } from '../lib/index.js';
import { state, lists, visibleItems, isEdited, latestResponse } from './state.js';
import { $, el, statusClass } from './dom.js';

let frame = 0;
let scrollToSelected = false;

// Renders on the next animation frame. Read list state from visibleItems(), never from the DOM.
export function renderList({ scroll = false } = {}) {
  scrollToSelected = scrollToSelected || scroll;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const items = visibleItems();
    const list = $('requestList');
    const hadFocus = list.contains(document.activeElement);
    list.replaceChildren(...(items.length ? items.map(renderListItem) : [emptyListItem()]));
    const selected = list.querySelector('li.selected');
    // Only when the selection changed — not on every keystroke in the editor.
    if (scrollToSelected) selected?.scrollIntoView({ block: 'nearest' });
    scrollToSelected = false;
    // Rows are rebuilt, so keyboard focus inside the list would otherwise fall back to the body.
    if (hadFocus) (selected || list.querySelector('li[data-id]'))?.focus({ preventScroll: true });
    $('collectionCaptured').textContent = state.captured.length ? `Captured · ${state.captured.length}` : 'Captured';
    $('collectionSaved').textContent = state.saved.length ? `Saved · ${state.saved.length}` : 'Saved';
    $('listCount').textContent = items.length || '';
  });
}

function emptyListItem() {
  let title;
  let text;
  if (state.filter && lists()[state.tab].length) [title, text] = ['No matching requests', 'Try another filter or collection.'];
  else if (state.tab === 'saved') [title, text] = ['Nothing saved yet', 'Pick a request and hit Save.'];
  else if (!state.recording) [title, text] = ['Recording is paused', 'Resume it to capture new requests.'];
  else [title, text] = ['Waiting for requests…', 'Reload the page or click around.'];
  return el('li', 'empty', '', [el('strong', '', title), text]);
}

function renderListItem(item) {
  const selected = item.id === state.selectedId;
  const li = el('li', selected ? 'selected' : '');
  li.dataset.id = item.id;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(selected));
  li.tabIndex = selected ? 0 : -1;

  let host = '';
  let path = item.url;
  try {
    const u = new URL(item.url);
    host = u.host;
    path = u.pathname + u.search;
  } catch { /* keep raw url */ }

  const main = el('span', 'path', item.kind === 'saved' ? item.name || path : path);
  if (isEdited(item)) main.prepend(el('span', 'edited', '●'));

  const res = latestResponse(item);
  const status = el('span', res ? `status ${statusClass(res.status)}` : 'status', res ? String(res.status || 'ERR') : '');
  // The row truncates; the full value lives in the tooltip (host for saved rows, time, edited).
  li.title = `${item.method} ${item.url}${res?.time != null ? `\n${formatTime(res.time)}` : ''}${isEdited(item) ? '\n(edited)' : ''}`;
  li.setAttribute('aria-label', `${item.method} ${item.kind === 'saved' && item.name ? item.name : host + path}${res ? `, ${res.status || 'failed'}` : ''}`);
  li.append(el('span', `method m-${item.method.toLowerCase()}`, item.method), main, status);
  return li;
}
