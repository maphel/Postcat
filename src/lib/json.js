import { parseHeaders } from './headers.js';

// Re-indents valid JSON as text. Never round-trips values through JSON.parse/stringify, which
// would silently change big integers (IDs!) and number spellings like 1.10 or 1E+2.
const stripBom = (text) => text.replace(/^\uFEFF/, '');

export function prettyBody(text) {
  const src = stripBom(text).trim();
  if (!/^[[{]/.test(src) || !isJson(src)) return text;
  const WS = ' \t\n\r';
  let out = '';
  let depth = 0;
  const newline = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (WS.includes(c)) {
      i++;
    } else if (c === '{' || c === '[') {
      let j = i + 1;
      while (WS.includes(src[j])) j++;
      if (src[j] === (c === '{' ? '}' : ']')) {
        out += c + src[j];
        i = j + 1;
      } else {
        depth++;
        out += c + newline();
        i++;
      }
    } else if (c === '}' || c === ']') {
      depth--;
      out += newline() + c;
      i++;
    } else if (c === ',') {
      out += `,${newline()}`;
      i++;
    } else if (c === ':') {
      out += ': ';
      i++;
    } else {
      let j = i;
      while (j < src.length && !(WS + ',:]}').includes(src[j])) j++;
      out += src.slice(i, j);
      i = j;
    }
  }
  return out;
}

// ---------- JSON highlighting ----------

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

// Splits pretty-printed JSON into [className, text] pieces; className is '' for plain text.
export function tokenizeJson(text) {
  const tokens = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    if (m.index > last) tokens.push(['', text.slice(last, m.index)]);
    if (m[1] && m[2]) {
      tokens.push(['j-key', m[1]], ['', m[2]]);
    } else if (m[1]) {
      tokens.push(['j-str', m[1]]);
    } else if (m[3]) {
      tokens.push([m[3] === 'null' ? 'j-null' : 'j-bool', m[3]]);
    } else {
      tokens.push(['j-num', m[4]]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push(['', text.slice(last)]);
  return tokens;
}

// { text, json }: pretty-printed text and whether it was valid JSON.
export function formatBody(text) {
  return { text: prettyBody(text), json: isJson(text) };
}

function isJson(text) {
  text = stripBom(text);
  if (!/^\s*[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------- validation & errors ----------

// null for valid JSON, else { message, line, column } (1-based) for the first syntax error.
// JSON.parse does the validation; V8 no longer reports a position for every error, so a small
// scanner locates it.
export function jsonError(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    let found = null;
    try {
      found = locateJsonError(text);
    } catch { /* e.g. stack overflow on absurd nesting: fall back to JSON.parse's message */ }
    found = found || { message: e.message.replace(/\s*in JSON at position \d+.*$/s, ''), pos: 0 };
    const before = text.slice(0, found.pos);
    return {
      message: found.message,
      line: before.split('\n').length,
      column: found.pos - before.lastIndexOf('\n'),
    };
  }
}

const JSON_LITERAL = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)/;

function locateJsonError(text) {
  let i = 0;
  const fail = (message) => { throw { message, pos: i }; };
  const token = () => (i < text.length ? `unexpected '${String.fromCodePoint(text.codePointAt(i))}'` : 'unexpected end of input');
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };

  const string = () => {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') { i++; return; }
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) fail('Bad \\u escape in string');
          i += 6;
        } else if (n !== undefined && '"\\/bfnrt'.includes(n)) {
          i += 2;
        } else {
          fail('Bad escape in string');
        }
        continue;
      }
      if (c < ' ') fail('Line break or control character in string');
      i++;
    }
    fail('Unterminated string');
  };

  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail(`Expected a property name in double quotes, ${token()}`);
        string();
        ws();
        if (text[i] !== ':') fail(`Expected ':' after property name, ${token()}`);
        i++;
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail(`Expected ',' or '}', ${token()}`);
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail(`Expected ',' or ']', ${token()}`);
      }
    }
    if (c === '"') return string();
    const lit = JSON_LITERAL.exec(text.slice(i, i + 400));
    if (lit) { i += lit[0].length; return; }
    fail(token()[0].toUpperCase() + token().slice(1));
  };

  try {
    value();
    ws();
    if (i < text.length) fail('Unexpected content after the JSON value');
    return null;
  } catch (err) {
    if (err && typeof err.pos === 'number') return err;
    throw err;
  }
}

// Whether a request body is meant to be JSON: declared by Content-Type or shaped like it.
export function expectsJson(body, headersText) {
  const type = parseHeaders(headersText || '').find((h) => h.name.toLowerCase() === 'content-type')?.value || '';
  if (/json/i.test(type)) return body.trim() !== '';
  return !type && /^\s*[[{]/.test(body);
}
