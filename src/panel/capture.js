// Turning DevTools network entries into captured requests.
import { isXhrLike, fromHarEntry } from '../lib/index.js';
import { state, nextId, MAX_CAPTURED } from './state.js';
import { fetchRecordedBody } from './response.js';
import { abandonSend } from './sending.js';

const captureKey = (entry) => `${entry.startedDateTime} ${entry.request.method} ${entry.request.url}`;

// `occurrence` is set when importing: the n-th HAR entry with a given key is only new if fewer
// than n entries with that key were captured already. Identical requests fired in the same
// millisecond share a key, so a plain "seen" set would drop all but the first.
export function addCaptured(entry, occurrence) {
  if (!/^https?:/i.test(entry.request.url)) return false;
  if (state.xhrOnly && !isXhrLike(entry)) return false;
  const key = captureKey(entry);
  const have = state.seen.get(key) || 0;
  if (occurrence !== undefined && occurrence <= have) return false;
  state.seen.set(key, have + 1);

  const recorded = fromHarEntry(entry);
  const original = { method: recorded.method, url: recorded.url, headersText: recorded.headersText, body: recorded.body };
  const item = { id: nextId(), kind: 'captured', name: '', entry, original, ...recorded };
  state.captured.unshift(item);
  fetchRecordedBody(item);
  if (state.captured.length > MAX_CAPTURED) {
    // Drop the oldest entry, but never the one open in the editor.
    let idx = state.captured.length - 1;
    if (state.captured[idx].id === state.selectedId) idx--;
    const [dropped] = state.captured.splice(idx, 1);
    abandonSend(dropped.id);
    state.responses.delete(dropped.id);
  }
  return true;
}

// "Import log": everything DevTools has, minus what's already captured. Returns the count added.
export function importEntries(entries) {
  const occurrences = new Map();
  return entries.filter((entry) => {
    const key = captureKey(entry);
    const n = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, n);
    return addCaptured(entry, n);
  }).length;
}
