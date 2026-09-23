import { safeDecode } from './url.js';

// ---------- binary bodies ----------

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const ascii = (bytes, start, str) => [...str].every((c, i) => bytes[start + i] === c.charCodeAt(0));

// Content type from magic bytes, for missing or generic (octet-stream) Content-Type headers.
export function sniffMime(bytes) {
  const b = bytes;
  if (b.length < 4) return '';
  if (b[0] === 0x89 && ascii(b, 1, 'PNG')) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 'GIF8')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'audio/wav';
  if (ascii(b, 4, 'ftyp')) {
    if (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')) return 'image/avif';
    if (ascii(b, 8, 'M4A')) return 'audio/mp4';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (ascii(b, 0, 'OggS')) return 'audio/ogg';
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return 'text/plain; charset=utf-16';
  // MPEG frame sync: 11 set bits, a valid version (not "reserved") and a valid bitrate index.
  if (ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[2] >> 4) !== 0 && (b[2] >> 4) !== 0xf)) return 'audio/mpeg';
  if (ascii(b, 0, 'fLaC')) return 'audio/flac';
  if (ascii(b, 0, '%PDF')) return 'application/pdf';
  if (ascii(b, 0, 'wOF2')) return 'font/woff2';
  if (ascii(b, 0, 'wOFF')) return 'font/woff';
  if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return 'font/ttf';
  if (ascii(b, 0, 'OTTO')) return 'font/otf';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  if (ascii(b, 0, 'BM')) return 'image/bmp';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return 'application/zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';
  return '';
}

export function cleanMime(mime) {
  return (mime || '').split(';')[0].trim().toLowerCase();
}

const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/unknown']);

// How a response body is best shown: json | text | html | svg | image | video | audio | pdf | font | binary
export function previewKind(mime) {
  const m = cleanMime(mime);
  if (m === 'image/svg+xml') return 'svg';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('font/') || /^application\/(x-)?font|vnd\.ms-fontobject/.test(m)) return 'font';
  if (m === 'text/html' || m === 'application/xhtml+xml') return 'html';
  if (m === 'application/json' || m.endsWith('+json') || m.endsWith('/json')) return 'json';
  if (m.startsWith('text/') || m.endsWith('+xml') || /(javascript|ecmascript|xml|x-www-form-urlencoded|graphql|x-ndjson|jsonl|yaml|toml|csv)/.test(m)) return 'text';
  return 'binary';
}

const TEXT_KINDS = new Set(['json', 'text', 'html', 'svg']);

// Valid UTF-8 without NUL bytes in the first 64 KB.
export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 65536);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < bytes.length ? trimPartialUtf8(sample) : sample);
    return true;
  } catch {
    return false;
  }
}

// Drops a UTF-8 sequence cut off at the end of a sample.
function trimPartialUtf8(bytes) {
  let end = bytes.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = bytes[end - i];
    if ((b & 0xc0) === 0xc0) return bytes.subarray(0, end - i);
    if ((b & 0x80) === 0) break;
  }
  return bytes;
}

// Works out what a response body is and how to show it.
// Input: { text }, { base64 } or { bytes } plus the declared mime type.
// Output: { kind, mime, text?, bytes?, size }
function charsetOf(mime) {
  return /charset=["']?([\w.:-]+)/i.exec(mime || '')?.[1] || '';
}

// Decodes with the declared charset (or a UTF-16 BOM), falling back to UTF-8 for unknown names.
function decodeText(bytes, mime) {
  let charset = charsetOf(mime);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) charset = 'utf-16';
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch { /* unknown label: fall back */ }
  }
  return new TextDecoder().decode(bytes);
}

export function describeBody({ text, base64, bytes, mime }) {
  const declared = cleanMime(mime);
  if (!bytes && base64 != null) bytes = base64ToBytes(base64);
  let effective = declared;
  let sniffed = '';
  if (bytes && GENERIC_MIMES.has(declared)) {
    sniffed = sniffMime(bytes);
    effective = cleanMime(sniffed) || declared;
  }
  let kind = previewKind(effective);

  if (bytes && (TEXT_KINDS.has(kind) || (kind === 'binary' && looksLikeText(bytes)))) {
    text = decodeText(bytes, sniffed || mime);
    if (kind === 'binary') kind = 'text';
  }
  if (text != null && !bytes) {
    if (kind === 'binary') kind = 'text';
    if (!TEXT_KINDS.has(kind)) bytes = new TextEncoder().encode(text);
  }
  const size = bytes ? bytes.length : new TextEncoder().encode(text || '').length;
  return { kind, mime: effective || declared, text: text ?? null, bytes, size };
}

export function hexDump(bytes, max = 1024) {
  const lines = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const chars = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex}  |${chars}|`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return lines.join('\n');
}

const EXTENSIONS = {
  'application/json': 'json', 'text/html': 'html', 'text/plain': 'txt', 'text/css': 'css', 'text/csv': 'csv',
  'application/javascript': 'js', 'text/javascript': 'js', 'application/xml': 'xml', 'text/xml': 'xml',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'audio/mp4': 'm4a', 'audio/flac': 'flac', 'application/pdf': 'pdf', 'font/woff2': 'woff2', 'font/woff': 'woff',
  'font/ttf': 'ttf', 'font/otf': 'otf', 'application/zip': 'zip', 'application/gzip': 'gz',
};

// File name for "Save": last path segment if it has an extension, else "<segment|response>.<ext>".
export function fileNameFor(url, mime) {
  let last = '';
  try {
    last = safeDecode(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  } catch { /* keep empty */ }
  last = last.replace(/[\\/:*?"<>|]/g, '_');
  // An extension needs a letter — "v1.2" is a version, not a ".2" file.
  if (/\.[a-z][a-z0-9]{0,7}$/i.test(last)) return last;
  const ext = EXTENSIONS[cleanMime(mime)] || 'bin';
  return `${last || 'response'}.${ext}`;
}
