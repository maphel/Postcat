// Docking-aware layout: which of the three layouts is active (from the panel's own width, not the
// screen or the dock position), the narrow list/detail screens, the Request/Response switcher,
// the appearance (theme), and the resizers of the wide layout. Editing state lives in `state` and
// the DOM stays in place across layout changes, so drafts, selection and response views survive
// a resize; only focus needs help when the element it sits in is hidden by the new layout.
import { state, current, DEFAULT_LAYOUT, APPEARANCES } from './state.js';
import { persistSettings } from './storage.js';
import { $, closeMenus } from './dom.js';

const WIDE_MIN = 850;   // list + editor + response side by side
const MEDIUM_MIN = 580; // list + one detail pane (Request / Response switcher)

function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', `${state.layout.sidebarW}px`);
  root.setProperty('--req-w', `${state.layout.reqW}%`);
}

// min wins when the range is empty (e.g. a very narrow DevTools window).
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export const layoutMode = () => state.layoutMode;

// Narrow layout only: 'list' shows the request list full width, 'detail' the editor. Without a
// selected request there is nothing to show in the detail screen, so the list wins.
export function showScreen(screen) {
  state.screen = screen;
  applyScreen();
}

export function applyScreen() {
  const app = $('app');
  const before = app.dataset.screen;
  const screen = current() ? state.screen : 'list';
  app.dataset.screen = screen;
  if (state.layoutMode !== 'narrow' || before === screen) return;
  // A sensible focus position: the selected row when opening the list, the URL when opening details.
  const active = document.activeElement;
  if (screen === 'list') $('requestList').querySelector('li.selected')?.focus({ preventScroll: true });
  else if (!active || active === document.body || $('sidebar').contains(active)) $('url').focus({ preventScroll: true });
}

// Medium and narrow layouts: which of the two panes takes the detail area.
export function setDetailView(view) {
  state.detailView = view;
  applyDetailView();
}

function applyDetailView() {
  $('app').dataset.view = state.detailView;
  for (const b of $('viewTabs').querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.view === state.detailView));
}

export function setAppearance(value) {
  if (!APPEARANCES.includes(value)) return;
  state.appearance = value;
  applyAppearance();
  persistSettings();
}

// 'system' follows DevTools' own theme (which follows the OS unless changed in DevTools' settings).
export function applyAppearance() {
  const devtoolsDark = chrome.devtools?.panels?.themeName === 'dark';
  const dark = state.appearance === 'dark' || (state.appearance === 'system' && devtoolsDark);
  document.documentElement.classList.toggle('dark', dark);
  for (const b of $('appearance').querySelectorAll('button')) {
    const on = b.dataset.appearance === state.appearance;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function modeFor(width) {
  if (width >= WIDE_MIN) return 'wide';
  if (width >= MEDIUM_MIN) return 'medium';
  return 'narrow';
}

function updateLayout(width) {
  const mode = modeFor(width);
  if (mode === state.layoutMode) return;
  const active = document.activeElement;
  state.layoutMode = mode;
  closeMenus();
  $('app').dataset.layout = mode;
  // Save sits next to Send when there is room, and on the context row (with New) when there is not.
  const saveBtn = $('saveBtn');
  if (mode === 'narrow') $('context').append(saveBtn);
  else $('moreBtn').before(saveBtn);
  // Keep the focused element visible: a pane that just lost its side-by-side place becomes the shown one.
  const focused = active && active !== document.body ? active : null;
  if (focused) {
    if ($('resPane').contains(focused)) state.detailView = 'response';
    else if ($('reqPane').contains(focused)) state.detailView = 'request';
  }
  applyDetailView();
  applyScreen();
  if (!focused) return;
  if (focused.checkVisibility()) {
    if (focused !== document.activeElement) focused.focus({ preventScroll: true });
  } else {
    // Hidden by the new layout (e.g. a list row when the details take the width): the nearest useful spot.
    ($('app').dataset.screen === 'list' ? $('requestList').querySelector('li.selected') : $('url'))?.focus({ preventScroll: true });
  }
}

function bindResizer(handle, onMove, onReset) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev) => { onMove(ev); applyLayout(); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      persistSettings();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => {
    onReset();
    applyLayout();
    persistSettings();
  });
}

export function initLayout() {
  bindResizer(
    $('sidebarResizer'),
    (e) => { state.layout.sidebarW = Math.round(clamp(e.clientX, 160, window.innerWidth * 0.45)); },
    () => { state.layout.sidebarW = DEFAULT_LAYOUT.sidebarW; },
  );
  bindResizer(
    $('splitResizer'),
    (e) => {
      const rect = $('split').getBoundingClientRect();
      if (!rect.width) return;
      state.layout.reqW = Math.round(clamp(((e.clientX - rect.left) / rect.width) * 100, 20, 80));
    },
    () => { state.layout.reqW = DEFAULT_LAYOUT.reqW; },
  );
  applyLayout();
  applyDetailView();
  applyAppearance();
  const app = $('app');
  state.layoutMode = ''; // force the first update
  updateLayout(app.clientWidth);
  new ResizeObserver((entries) => updateLayout(entries[0].contentRect.width)).observe(app);
}
