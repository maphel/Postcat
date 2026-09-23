// Small DOM helpers, the toast, the clipboard, and the popover menus.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  if (children) node.append(...children);
  return node;
}

export function statusClass(status) {
  if (!status) return 's-err';
  if (status < 300) return 's-ok';
  if (status < 400) return 's-redirect';
  if (status < 500) return 's-client';
  return 's-err';
}

export const isTyping = (target) => !!target.closest?.('input, textarea, select');

let toastTimer = 0;
export function toast(text, action) {
  $('toastText').textContent = text;
  const btn = $('toastAction');
  btn.hidden = !action;
  btn.onclick = action ? () => { action.run(); hideToast(); } : null;
  if (action) btn.textContent = action.label;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 1800);
}

function hideToast() {
  $('toast').classList.remove('show');
}

// navigator.clipboard is unreliable inside DevTools panels; execCommand still works there.
export function copyText(text, message) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast(message);
}

// ---------- menus ----------
// Every `[popover][role=menu]` is opened by its `[popovertarget]` button. The browser handles
// light dismiss, Escape and the top layer (so menus are never clipped by a pane); we add the
// placement under the button, arrow-key navigation, and closing after an item was activated.

// menuitem, menuitemcheckbox and menuitemradio, in DOM order.
const menuItems = (menu) => [...menu.querySelectorAll('[role^=menuitem]')].filter((n) => !n.hidden && !n.disabled && n.offsetParent !== null);

// Placed synchronously in `beforetoggle` (the popover has no size yet): anchored to the button's
// right edge, below it, or above it when the space below is short. The Popover API keeps menus
// in the top layer, so no pane can clip them.
const MENU_ESTIMATE = 160; // px; enough for the tallest/widest menu, only used to pick a side
function placeMenu(menu, button) {
  const r = button.getBoundingClientRect();
  const st = menu.style;
  st.left = st.right = st.top = st.bottom = 'auto';
  if (r.right >= MENU_ESTIMATE || r.right > window.innerWidth - r.left) st.right = `${Math.max(4, window.innerWidth - r.right)}px`;
  else st.left = `${Math.max(4, r.left)}px`;
  const below = window.innerHeight - r.bottom - 4;
  if (below >= MENU_ESTIMATE || below >= r.top) {
    st.top = `${r.bottom + 3}px`;
    st.maxHeight = `${Math.max(60, below - 3)}px`;
  } else {
    st.bottom = `${window.innerHeight - r.top + 3}px`;
    st.maxHeight = `${Math.max(60, r.top - 7)}px`;
  }
}

export function initMenus() {
  for (const menu of document.querySelectorAll('[popover][role=menu]')) {
    const button = document.querySelector(`[popovertarget="${menu.id}"]`);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    menu.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      button.setAttribute('aria-expanded', String(open));
      if (open) placeMenu(menu, button);
    });
    menu.addEventListener('toggle', (e) => {
      if (e.newState === 'open') menuItems(menu)[0]?.focus();
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation(); // the document-level shortcuts (list navigation) must not see it
      const items = menuItems(menu);
      const idx = items.indexOf(document.activeElement);
      items[(idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    });
    // Activating an item (including the checkbox and radio items) closes the menu.
    menu.addEventListener('click', (e) => {
      if (e.target.closest('[role^=menuitem]')) menu.hidePopover();
    });
  }
}

export function closeMenus() {
  for (const menu of document.querySelectorAll('[popover]:popover-open')) menu.hidePopover();
}
