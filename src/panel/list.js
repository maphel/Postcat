// The request list on the left.
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
    list.replaceChildren(...(items.length ? items.map(renderListItem) : [emptyListItem()]));
    // Only when the selection changed — not on every keystroke in the editor.
    if (scrollToSelected) list.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
    scrollToSelected = false;
    $('capturedCount').textContent = state.captured.length || '';
    $('savedCount').textContent = state.saved.length || '';
  });
}

function emptyListItem() {
  let text;
  if (state.filter && lists()[state.tab].length) text = 'No requests match the filter.';
  else if (state.tab === 'saved') text = 'Nothing saved yet.\nPick a request and hit ☆ Save.';
  else if (!state.recording) text = 'Recording is paused.';
  else text = 'Waiting for requests…\nReload the page or click around.';
  const li = el('li', 'empty', text);
  li.style.whiteSpace = 'pre-line';
  return li;
}

function renderListItem(item) {
  const li = el('li', item.id === state.selectedId ? 'selected' : '');
  li.dataset.id = item.id;

  let host = '';
  let path = item.url;
  try {
    const u = new URL(item.url);
    host = u.host;
    path = u.pathname + u.search;
  } catch { /* keep raw url */ }

  const main = el('span', 'path', item.kind === 'saved' ? item.name || path : path);
  if (isEdited(item)) main.prepend(el('span', 'edited', '●'));
  const sub = el('span', 'host', item.kind === 'saved' ? `${host}${path}` : host);

  const right = el('span', 'right');
  const res = latestResponse(item);
  if (res) {
    right.append(el('span', `status ${statusClass(res.status)}`, String(res.status || 'ERR')));
    if (res.time != null) right.append(el('span', 'time', formatTime(res.time)));
  }

  li.title = `${item.method} ${item.url}${isEdited(item) ? '\n(edited)' : ''}`;
  li.append(el('span', `method m-${item.method.toLowerCase()}`, item.method), el('span', 'text', '', [main, sub]), right);
  return li;
}
