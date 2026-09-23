// The request list on the left: compact single-line rows (method, name or path, status), and the
// inline rename of a saved request's name.
import { formatTime, captureInfo } from '../lib/index.js';
import { state, lists, visibleItems, isEdited, latestResponse, defaultName } from './state.js';
import { persistSavedSoon } from './storage.js';
import { $, el, statusClass } from './dom.js';

let frame = 0;
let scrollToSelected = false;
let rebuilding = false; // true while replaceChildren() runs: the blur it fires on a rename input is not a commit

// Renders on the next animation frame. Read list state from visibleItems(), never from the DOM.
export function renderList({ scroll = false } = {}) {
  scrollToSelected = scrollToSelected || scroll;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const items = visibleItems();
    const list = $('requestList');
    const hadFocus = list.contains(document.activeElement);
    // A rename in progress survives the rebuild (e.g. a send finishing re-renders the list): its
    // text and caret carry over to the recreated input.
    const live = list.querySelector('input.rename');
    const draft = live ? { value: live.value, start: live.selectionStart, end: live.selectionEnd } : null;
    rebuilding = true;
    list.replaceChildren(...(items.length ? items.map(renderListItem) : [emptyListItem()]));
    rebuilding = false;
    const selected = list.querySelector('li.selected');
    // Only when the selection changed — not on every keystroke in the editor.
    if (scrollToSelected) selected?.scrollIntoView({ block: 'nearest' });
    scrollToSelected = false;
    // Rows are rebuilt, so keyboard focus inside the list would otherwise fall back to the body.
    if (hadFocus) (selected || list.querySelector('li[data-id]'))?.focus({ preventScroll: true });
    const renaming = list.querySelector('input.rename');
    if (renaming) {
      renaming.focus({ preventScroll: true });
      if (draft) {
        renaming.value = draft.value;
        renaming.setSelectionRange(draft.start, draft.end);
      } else {
        renaming.select();
      }
    }
    $('capturedCount').textContent = state.captured.length || '';
    $('savedCount').textContent = state.saved.length || '';
    $('listCount').textContent = items.length || '';
    fitListTools();
  });
}

// The Captured / Saved tabs share their row with the record and New buttons. When the row overflows
// (a narrow sidebar, big counts), the counts go; both labels stay visible and clickable.
function fitListTools() {
  const tools = $('listTools');
  tools.classList.remove('no-counts');
  if (tools.scrollWidth > tools.clientWidth) tools.classList.add('no-counts');
}

export function initList() {
  new ResizeObserver(fitListTools).observe($('sidebar'));
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

  const main = el('span', 'path');
  if (state.renaming === item.id) {
    main.append(renameInput(item));
  } else {
    main.textContent = item.kind === 'saved' ? item.name || path : path;
    if (isEdited(item)) { // the one edited indicator (the narrow switcher repeats it while the list is out of view)
      const dot = el('span', 'edited', '●');
      dot.title = 'Edited — Reset restores the recorded request';
      main.prepend(dot);
    }
  }

  const res = latestResponse(item);
  const status = el('span', res ? `status ${statusClass(res.status)}` : 'status', res ? String(res.status || 'ERR') : '');
  // The row truncates; the tooltip has the full URL, the capture details (time, type, duration) or
  // the time of the last response, and the edited state.
  const detail = item.kind === 'captured' ? captureInfo(item) : res?.time != null ? formatTime(res.time) : '';
  li.title = `${item.method} ${item.url}${detail ? `\n${detail}` : ''}${isEdited(item) ? '\n(edited)' : ''}`;
  li.setAttribute('aria-label', `${item.method} ${item.kind === 'saved' && item.name ? item.name : host + path}${res ? `, ${res.status || 'failed'}` : ''}`);
  li.append(el('span', `method m-${item.method.toLowerCase()}`, item.method), main, status);
  return li;
}

// ---------- inline rename (saved requests) ----------
// `state.renaming` holds the id; the row renders an input (#name) instead of its label, so the
// rAF-batched re-renders cannot lose it. Enter and blur commit, Escape cancels.

function renameInput(item) {
  const input = el('input', 'rename');
  input.id = 'name';
  input.value = item.name || '';
  input.placeholder = defaultName(item);
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Request name');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the list's keys (Enter selects, Delete removes) and the shortcuts must not see it
    if (e.key === 'Enter') endRename(true);
    else if (e.key === 'Escape') endRename(false);
  });
  // Chrome fires blur when the focused input is removed: a rebuild of the rows is not a commit.
  input.addEventListener('blur', () => { if (!rebuilding && input.isConnected) endRename(true); });
  input.addEventListener('click', (e) => e.stopPropagation()); // a click in the input is not a row selection
  return input;
}

// Ends the rename in progress, if any; `commit` stores the typed name (autosaved as any edit).
export function endRename(commit) {
  const id = state.renaming;
  if (id == null) return;
  state.renaming = null;
  const item = state.saved.find((i) => i.id === id);
  const input = $('name');
  if (commit && item && input) {
    item.name = input.value.trim();
    persistSavedSoon();
  }
  renderList();
  document.dispatchEvent(new CustomEvent('postcat:renamed')); // the narrow navigation row shows the name (editor.js)
}
