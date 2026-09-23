// Resizable sidebar and request/response split.
import { state, DEFAULT_LAYOUT } from './state.js';
import { persistSettings } from './storage.js';
import { $ } from './dom.js';

function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty('--sidebar-w', `${state.layout.sidebarW}px`);
  root.setProperty('--req-w', `${state.layout.reqW}%`);
}

// min wins when the range is empty (e.g. a very narrow DevTools window).
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

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
    (e) => { state.layout.sidebarW = Math.round(clamp(e.clientX, 200, window.innerWidth - 420)); },
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
}
