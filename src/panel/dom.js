// Small DOM helpers, the toast and the clipboard.

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
