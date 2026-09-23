// Entry point: wires DOM events to the modules and boots the panel.
import { headersToText, textToRows, urlToParams, prettyBody } from '../lib/index.js';
import { state, current } from './state.js';
import { loadStorage, persistSettings, flushPending } from './storage.js';
import { $, toast, copyText, isTyping, initMenus, openMenuAt } from './dom.js';
import { renderList, initList } from './list.js';
import { renderEditor, renderReqTab, renderContextName, afterEdit, paramsKv, headersKv } from './editor.js';
import { renderResponse, renderResTab, setBodyMode, saveResponseBody, shownBodyText, initResponse } from './response.js';
import { send, cancelSend, isSending } from './sending.js';
import { addCaptured, importEntries } from './capture.js';
import { onSearch } from './search.js';
import { initLayout, showScreen, setDetailView, setAppearance, layoutMode } from './layout.js';
import {
  select, save, duplicate, reset, rename, moveSelection, remove, clearCaptured, copyCurl, newRequest,
  tryParseCurl, switchTab, setFilter, setRecording,
} from './actions.js';

// ---------- editor ----------

$('url').addEventListener('input', (e) => {
  const item = current();
  if (!item) return;
  item.url = e.target.value;
  paramsKv.set(urlToParams(item.url));
  afterEdit(item);
});

$('url').addEventListener('paste', (e) => {
  const item = current();
  const parsed = tryParseCurl(e.clipboardData?.getData('text') || '');
  if (parsed === null || !item) return;
  e.preventDefault();
  if (!parsed) {
    toast('Couldn’t read that cURL command.');
    return;
  }
  Object.assign(item, { method: parsed.method, url: parsed.url, headersText: headersToText(parsed.headers), body: parsed.body });
  renderEditor();
  afterEdit(item);
  toast('Imported from cURL');
});

$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

const bindField = (id, field) => $(id).addEventListener('input', (e) => {
  const item = current();
  if (!item) return;
  item[field] = e.target.value;
  afterEdit(item);
});
bindField('headers', 'headersText');
bindField('body', 'body');

$('method').addEventListener('change', (e) => {
  const item = current();
  if (!item) return;
  item.method = e.target.value;
  afterEdit(item);
});

$('reqTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button[data-tab]')?.dataset.tab;
  if (!tab) return;
  state.reqTab = tab;
  renderReqTab();
  persistSettings();
});

$('bulkBtn').addEventListener('click', () => {
  const item = current();
  state.bulkHeaders = !state.bulkHeaders;
  if (item) {
    headersKv.set(textToRows(item.headersText));
    $('headers').value = item.headersText;
  }
  renderReqTab();
  persistSettings();
});

$('beautifyBtn').addEventListener('click', () => {
  const item = current();
  if (!item) return;
  const pretty = prettyBody(item.body);
  if (pretty === item.body) {
    toast('Body isn’t valid JSON');
    return;
  }
  item.body = pretty;
  $('body').value = item.body;
  afterEdit(item);
});

$('sendBtn').addEventListener('click', () => (isSending() ? cancelSend() : send()));
document.addEventListener('postcat:send', () => send()); // "Send again" buttons in response notices
$('saveBtn').addEventListener('click', save);
$('dupBtn').addEventListener('click', duplicate);
$('deleteBtn').addEventListener('click', remove);
$('curlBtn').addEventListener('click', copyCurl);
$('resetBtn').addEventListener('click', reset);
$('renameBtn').addEventListener('click', rename);
document.addEventListener('postcat:renamed', renderContextName); // list.js committed or cancelled a rename
$('newBtn').addEventListener('click', () => newRequest());
$('newListBtn').addEventListener('click', () => newRequest());
$('newContextBtn').addEventListener('click', () => newRequest());

// Request / Response switcher (medium and narrow layouts) and the way back to the list (narrow).
$('viewTabs').addEventListener('click', (e) => {
  const view = e.target.closest('button[data-view]')?.dataset.view;
  if (view) setDetailView(view);
});
$('backBtn').addEventListener('click', () => showScreen('list'));

// ---------- response ----------

$('resTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button[data-tab]')?.dataset.tab;
  if (!tab) return;
  state.resTab = tab;
  renderResTab();
});

$('resSource').addEventListener('change', (e) => {
  const item = current();
  if (!item) return;
  item.view = e.target.value;
  renderResponse();
});

$('resMode').addEventListener('click', (e) => {
  const mode = e.target.closest('button[data-mode]')?.dataset.mode;
  if (mode) setBodyMode(mode);
});
for (const id of ['resPreviewItem', 'resRawItem']) $(id).addEventListener('click', (e) => setBodyMode(e.currentTarget.dataset.mode));

// Copy and Save: inline icon buttons, or the ⋯ menu's items when the pane is too narrow for them.
const copyResponse = () => {
  const text = shownBodyText();
  if (text != null) copyText(text, 'Response copied');
};
$('resCopy').addEventListener('click', copyResponse);
$('copyResBtn').addEventListener('click', copyResponse);
$('resSave').addEventListener('click', saveResponseBody);
$('saveResBtn').addEventListener('click', saveResponseBody);

// ---------- sidebar ----------

$('recordBtn').addEventListener('click', () => setRecording(!state.recording));
$('clearBtn').addEventListener('click', clearCaptured);

$('importBtn').addEventListener('click', () => {
  chrome.devtools.network.getHAR((har) => {
    // getHAR is oldest-first; addCaptured prepends, so newest ends on top.
    const added = importEntries(har?.entries || []);
    switchTab('captured');
    toast(added ? `Imported ${added} request${added === 1 ? '' : 's'}` : 'Nothing new to import');
  });
});

function applyXhrOnly() {
  $('xhrOnly').setAttribute('aria-checked', String(state.xhrOnly));
  $('captureBtn').setAttribute('aria-pressed', String(state.xhrOnly));
  $('captureBtn').title = state.xhrOnly ? 'Options · XHR/Fetch only' : 'Options · all request types';
}
$('xhrOnly').addEventListener('click', () => {
  state.xhrOnly = !state.xhrOnly;
  applyXhrOnly();
  persistSettings();
});

$('appearance').addEventListener('click', (e) => {
  const value = e.target.closest('button[data-appearance]')?.dataset.appearance;
  if (value) setAppearance(value);
});

$('filterInput').addEventListener('input', (e) => setFilter(e.target.value));
$('collection').addEventListener('click', (e) => {
  const tab = e.target.closest('button[data-tab]')?.dataset.tab;
  if (tab) switchTab(tab);
});

$('requestList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) select(Number(li.dataset.id), { reveal: true });
});
$('requestList').addEventListener('keydown', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li || (e.key !== 'Enter' && e.key !== ' ') || e.metaKey || e.ctrlKey) return; // ⌘/Ctrl + Enter only sends
  e.preventDefault();
  select(Number(li.dataset.id), { reveal: true });
});
// Double-click on a saved row renames it in place (its clicks already selected it).
$('requestList').addEventListener('dblclick', (e) => {
  if (e.target.closest('li[data-id]') && current()?.kind === 'saved') rename();
});
// Right-click on a row: the request menu (the same one as the ⋯ next to Send) at the pointer, for that row.
$('requestList').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  e.preventDefault();
  if (Number(li.dataset.id) !== state.selectedId) select(Number(li.dataset.id));
  const open = () => openMenuAt($('moreMenu'), e.clientX, e.clientY);
  // On macOS contextmenu fires on mousedown; a popover opened now would be light-dismissed by the
  // pointerup that follows. Open once the button is released.
  if (e.buttons & 2) document.addEventListener('pointerup', () => setTimeout(open, 0), { once: true });
  else open();
});

// ---------- global ----------

// Tab lists: Left/Right move between tabs and activate them.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tab = e.target.closest?.('[role=tab]');
  const list = tab?.closest('[role=tablist]');
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role=tab]')].filter((t) => !t.hidden);
  const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  e.preventDefault();
  next.focus();
  next.click();
});

// Keys inside an open menu belong to the menu (dom.js): arrows never move the list selection,
// `/` never leaves it for the filter, and Delete/Backspace on a focused item never delete the request.
const inMenu = (target) => !!target.closest?.('[popover]');

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    send();
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  } else if (e.key === 'F2' && !inMenu(e.target)) {
    e.preventDefault();
    rename(); // saved requests only; the rename input itself keeps its keys (list.js)
  } else if (e.key === 'Escape' && isTyping(e.target)) {
    e.target.blur();
  } else if (!isTyping(e.target) && !inMenu(e.target) && !mod) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === '/') {
      e.preventDefault();
      if (layoutMode() === 'narrow') showScreen('list');
      $('filterInput').focus();
      $('filterInput').select();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && current() && !e.repeat) {
      e.preventDefault();
      remove();
    }
  }
});

// Pasting a cURL command anywhere outside an input creates a new saved request.
document.addEventListener('paste', (e) => {
  if (isTyping(e.target)) return;
  const parsed = tryParseCurl(e.clipboardData?.getData('text') || '');
  if (parsed === null) return;
  e.preventDefault();
  if (!parsed) {
    toast('Couldn’t read that cURL command.');
    return;
  }
  newRequest(parsed);
  toast('Imported from cURL');
});

window.postcatSearch = onSearch; // called by devtools.js

let earlyEntries = []; // finished before settings (xhrOnly, tab) were loaded
chrome.devtools.network.onRequestFinished.addListener((entry) => {
  if (earlyEntries) {
    earlyEntries.push(entry);
    return;
  }
  if (state.recording && addCaptured(entry) && state.tab === 'captured') renderList();
});

window.addEventListener('pagehide', flushPending);

// Before the stored appearance is known, follow DevTools' theme so the panel doesn't flash white.
if (chrome.devtools.panels.themeName === 'dark') document.documentElement.classList.add('dark');
initMenus();

loadStorage().then(() => {
  const buffered = earlyEntries;
  earlyEntries = null;
  for (const entry of buffered) addCaptured(entry);
  applyXhrOnly();
  initLayout();
  initList();
  initResponse();
  setRecording(true);
  setFilter(state.filterText);
  switchTab(state.tab);
  renderResTab();
  renderEditor();
});
