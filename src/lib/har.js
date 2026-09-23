import { headersToText } from './headers.js';

const XHR_TYPES = new Set(['xhr', 'fetch']);

// Unknown resource types are kept so nothing is silently dropped.
export function isXhrLike(entry) {
  const type = entry._resourceType;
  return !type || XHR_TYPES.has(type);
}

export function fromHarEntry(entry) {
  const req = entry.request;
  const res = entry.response || {};
  return {
    method: req.method,
    url: req.url,
    // HTTP/2 pseudo headers (:authority, :path, …) can't be sent as regular headers.
    headersText: headersToText((req.headers || []).filter((h) => !h.name.startsWith(':'))),
    body: req.postData?.text ?? '',
    startedDateTime: entry.startedDateTime,
    resourceType: entry._resourceType || '',
    recorded: {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers || [],
      mimeType: res.content?.mimeType || '',
      size: res.content?.size ?? res.bodySize,
      time: entry.time,
      error: res._error || '', // Chrome: net::ERR_… for failed/blocked requests (status 0)
      location: (res.headers || []).find((h) => h.name.toLowerCase() === 'location')?.value || '',
    },
  };
}

// "/regex/flags" is a regex, anything else a case-insensitive substring. Matches "METHOD url".
export function compileFilter(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const re = /^\/(.+)\/([a-z]*)$/.exec(trimmed);
  if (re) {
    try {
      // g/y make RegExp#test stateful (lastIndex) — results would alternate between calls.
      const regex = new RegExp(re[1], re[2].replace(/[gy]/g, ''));
      return (item) => regex.test(`${item.method} ${item.url}`);
    } catch {
      // Fall through to substring matching while the regex is still being typed.
    }
  }
  const needle = trimmed.toLowerCase();
  return (item) => `${item.method} ${item.url}`.toLowerCase().includes(needle);
}
