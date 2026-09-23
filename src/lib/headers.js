export function headersToText(headers) {
  return headers.map((h) => `${h.name}: ${h.value}`).join('\n');
}

// One "Name: value" per line; empty lines and lines starting with # or // are ignored.
export function parseHeaders(text) {
  const headers = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return headers;
}

// ---------- key/value rows (headers table) ----------

// Like parseHeaders, but keeps disabled ("# ") lines so the table can show them unchecked.
export function textToRows(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    let enabled = true;
    if (line.startsWith('#') || line.startsWith('//')) {
      enabled = false;
      line = line.replace(/^(#|\/\/)\s*/, '');
    }
    const idx = line.indexOf(':');
    rows.push(idx > 0
      ? { enabled, key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() }
      : { enabled, key: line, value: '' });
  }
  return rows;
}

// Rows without a name can't be sent and would re-parse as garbage (": value"), so they're dropped.
export function rowsToText(rows) {
  return rows
    .filter((r) => r.key)
    .map((r) => `${r.enabled ? '' : '# '}${r.key}: ${r.value}`)
    .join('\n');
}
