// Key/value table used for query params and headers.
import { el } from './dom.js';

// Rows are { enabled, key, value, ...extra }; extra fields (e.g. a param's raw text) are kept
// untouched so the caller can write unchanged rows back verbatim.
export function createKvEditor(root, { toggles, keyPlaceholder, valuePlaceholder, onChange }) {
  let rows = [];
  root.classList.toggle('no-toggle', !toggles);

  const emit = () => onChange(rows.filter((r) => r.key || r.value));

  function ensureTrailingRow() {
    const last = rows[rows.length - 1];
    if (last && !last.key && !last.value) return;
    const row = { enabled: true, key: '', value: '' };
    rows.push(row);
    root.append(rowEl(row));
  }

  function rowEl(row) {
    const div = el('div', 'kv-row');
    if (toggles) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = row.enabled;
      cb.title = 'Send this header';
      cb.addEventListener('change', () => {
        row.enabled = cb.checked;
        div.classList.toggle('off', !row.enabled);
        emit();
      });
      div.classList.toggle('off', !row.enabled);
      div.append(cb);
    } else {
      div.append(el('span'));
    }
    const input = (field, placeholder) => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = `kv-${field}`;
      inp.value = row[field];
      inp.placeholder = placeholder;
      inp.spellcheck = false;
      inp.addEventListener('input', () => {
        row[field] = inp.value;
        ensureTrailingRow();
        emit();
      });
      return inp;
    };
    const del = el('button', 'kv-del', '✕');
    del.title = 'Remove';
    del.tabIndex = -1;
    del.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      div.remove();
      ensureTrailingRow();
      emit();
    });
    div.append(input('key', keyPlaceholder), input('value', valuePlaceholder), del);
    return div;
  }

  return {
    set(next) {
      rows = next.map((r) => ({ ...r, enabled: r.enabled ?? true }));
      root.replaceChildren(...rows.map(rowEl));
      ensureTrailingRow();
    },
  };
}
