// Shared panel state and the pure selectors over it.

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const MAX_CAPTURED = 1000;
export const DEFAULT_LAYOUT = { sidebarW: 320, reqW: 50 };

export const state = {
  recording: true,
  xhrOnly: true,
  tab: 'captured',
  reqTab: 'params',
  resTab: 'resBody',
  bulkHeaders: false,
  layout: { ...DEFAULT_LAYOUT },
  filterText: '',
  filter: null,
  captured: [],
  saved: [],
  selectedId: null,
  responses: new Map(), // item id -> last send result ({ pending } | { error } | response)
  seen: new Map(),      // HAR key -> number of captured entries with it (see capture.js)
  resModes: { html: 'raw' }, // Preview/Raw per body kind; everything else defaults to preview
};

let seq = 0;
export const nextId = () => ++seq;

export const lists = () => ({ captured: state.captured, saved: state.saved });
const findItem = (id) => state.captured.find((i) => i.id === id) || state.saved.find((i) => i.id === id);
export const current = () => findItem(state.selectedId);
export const visibleItems = () => lists()[state.tab].filter((i) => !state.filter || state.filter(i));

const EDITABLE = ['method', 'url', 'headersText', 'body'];
export const isEdited = (item) => !!item.original && EDITABLE.some((f) => item[f] !== item.original[f]);

export function defaultName(item) {
  try {
    return `${item.method} ${new URL(item.url).pathname}`;
  } catch {
    return `${item.method} ${item.url}`;
  }
}

export function copyOf(item, kind) {
  const { method, url, headersText, body } = item;
  return { id: nextId(), kind, name: item.name || defaultName(item), method, url, headersText, body };
}

// Latest known response for list badges: last successful send, else the recorded one.
export function latestResponse(item) {
  const sent = state.responses.get(item.id);
  if (sent?.cancelled) return item.recorded;
  if (sent && !sent.pending) return sent.error ? { status: 0 } : sent;
  return item.recorded;
}
