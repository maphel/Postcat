
// ---------- query params ----------

function splitUrl(url) {
  const hashIdx = url.indexOf('#');
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  const rest = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = rest.indexOf('?');
  return qIdx === -1
    ? { base: rest, query: '', hash }
    : { base: rest.slice(0, qIdx), query: rest.slice(qIdx + 1), hash };
}

export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodePair(pair) {
  const idx = pair.indexOf('=');
  return idx === -1
    ? { key: safeDecode(pair), value: '' }
    : { key: safeDecode(pair.slice(0, idx)), value: safeDecode(pair.slice(idx + 1)) };
}

// Rows carry the original `raw` pair so untouched params are written back byte-for-byte
// (re-encoding would e.g. turn a form-encoded "a+b" into a literal "a%2Bb").
export function urlToParams(url) {
  const { query } = splitUrl(url);
  if (!query) return [];
  return query.split('&').filter(Boolean).map((pair) => ({ ...decodePair(pair), raw: pair }));
}

// Keeps {{placeholders}} and already-safe characters readable instead of percent-encoding everything.
function encodeParam(s) {
  return encodeURIComponent(s).replace(/%(7B|7D|2C|3A|2F|40|24)/gi, (m) => safeDecode(m));
}

export function paramsToUrl(url, params) {
  const { base, hash } = splitUrl(url);
  const query = params
    .filter((p) => p.key || p.value)
    .map((p) => {
      if (p.raw !== undefined) {
        const original = decodePair(p.raw);
        if (original.key === p.key && original.value === p.value) return p.raw;
      }
      return p.value === '' ? encodeParam(p.key) : `${encodeParam(p.key)}=${encodeParam(p.value)}`;
    })
    .join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}
