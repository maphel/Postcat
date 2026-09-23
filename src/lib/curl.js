import { bytesToBase64 } from './body.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function toCurl({ method, url, headers, body }) {
  const parts = [`curl -X ${method} ${shellQuote(url)}`];
  // curl treats "-H 'X: '" as "remove X"; "-H 'X;'" sends an empty header.
  for (const h of headers) parts.push(`-H ${shellQuote(h.value === '' ? `${h.name};` : `${h.name}: ${h.value}`)}`);
  if (body) parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(' \\\n  ');
}

// ---------- cURL import ----------

const ANSI_ESCAPES = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };

// Chrome's "Copy as cURL (cmd)" uses ^ as the escape character and ^ + newline as continuation.
// Recognised by those continuations or by ^-escaped quotes/ampersands; converted to POSIX quoting.
function isCmdSyntax(input) {
  return /\^\s*\r?\n/.test(input) || /\^"/.test(input) || /\^[&|<>%]/.test(input);
}

function cmdToPosix(input) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '^') {
      if (input[i + 1] === '\r' && input[i + 2] === '\n') { out += ' '; i += 2; continue; }
      if (input[i + 1] === '\n') { out += ' '; i += 1; continue; }
      out += input[i + 1] === '"' ? (quoted ? '\\"' : '"') : input[i + 1] ?? '';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      out += c;
    } else if (c === '\\' && input[i + 1] === '"') {
      out += '\\"';
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Splits a POSIX shell command line into words: '…', "…", $'…' (Chrome's "Copy as cURL"), \ escapes.
export function shellSplit(input) {
  if (isCmdSyntax(input)) input = cmdToPosix(input);
  const words = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === '\\') {
      if (input[i + 1] === '\n') { i += 2; continue; }
      if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 3; continue; }
      cur += input[i + 1] ?? '';
      i += 2;
      inWord = true;
    } else if (c === '$' && input[i + 1] === "'") {
      i += 2;
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\') {
          const n = input[i + 1];
          if (n === 'x') { cur += String.fromCharCode(parseInt(input.substr(i + 2, 2), 16)); i += 4; continue; }
          if (n === 'u') { cur += String.fromCharCode(parseInt(input.substr(i + 2, 4), 16)); i += 6; continue; }
          cur += ANSI_ESCAPES[n] ?? n;
          i += 2;
        } else {
          cur += input[i++];
        }
      }
      i++;
      inWord = true;
    } else if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error('Unterminated quote');
      cur += input.slice(i + 1, end);
      i = end + 1;
      inWord = true;
    } else if (c === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && '"\\$`\n'.includes(input[i + 1])) {
          if (input[i + 1] !== '\n') cur += input[i + 1];
          i += 2;
        } else {
          cur += input[i++];
        }
      }
      if (i >= input.length) throw new Error('Unterminated quote');
      i++;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) { words.push(cur); cur = ''; inWord = false; }
      i++;
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

const CURL_DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json']);
// Flags that take a value we don't use — they must not swallow the URL.
const CURL_VALUE_FLAGS = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '--cacert', '--capath', '--cert',
  '--key', '--pass', '-w', '--write-out', '--retry', '--retry-delay', '--retry-max-time', '--resolve',
  '--connect-to', '--limit-rate', '-c', '--cookie-jar', '-D', '--dump-header', '-E', '--max-redirs',
  '-U', '--proxy-user', '-z', '--time-cond', '-K', '--config', '--interface', '--socks4', '--socks4a',
  '--socks5', '--socks5-hostname', '--stderr', '--trace', '--trace-ascii', '--url-query', '-C', '--continue-at',
  '--unix-socket', '--abstract-unix-socket', '--ciphers', '--tls-max', '--dns-servers', '--local-port',
  '--max-filesize', '--keepalive-time', '--expect100-timeout', '--happy-eyeballs-timeout-ms', '--speed-limit',
  '--speed-time', '-y', '-Y', '--pinnedpubkey', '--crlfile', '--engine', '--netrc-file', '--proto',
  '--proto-redir', '--proxy-header', '--noproxy', '--output-dir', '--etag-save', '--etag-compare',
  '--aws-sigv4', '--delegation', '--krb', '--service-name', '--tlsuser', '--tlspassword', '--tlsauthtype',
  '--form-string', '--doh-url', '--alt-svc', '--hsts', '--ipfs-gateway', '--variable', '--ca-native',
]);

function headerFrom(line) {
  const idx = line.indexOf(':');
  return idx > 0 ? { name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() } : null;
}

// btoa() only takes Latin-1; Basic auth credentials are UTF-8 in practice.
function base64Utf8(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

// -F fields become a real multipart/form-data body; @file parts get a placeholder (we can't read files).
function multipartBody(fields, boundary) {
  const parts = fields.map((field) => {
    const idx = field.indexOf('=');
    const name = idx === -1 ? field : field.slice(0, idx);
    const value = idx === -1 ? '' : field.slice(idx + 1);
    if (value.startsWith('@') || value.startsWith('<')) {
      const file = value.slice(1).split(';')[0];
      return `Content-Disposition: form-data; name="${name}"; filename="${file}"\r\nContent-Type: application/octet-stream\r\n\r\n(contents of ${file})`;
    }
    return `Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
  });
  return `--${boundary}\r\n${parts.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
}

// Returns { method, url, headers, body } or null if the text isn't a curl command.
export function parseCurl(text) {
  const args = shellSplit(text.trim());
  if (!/(^|[\\/])curl(\.exe)?$/i.test(args[0] || '')) return null;
  let method = null;
  let url = '';
  let asGet = false;
  let json = false;
  let upload = false;
  const headers = [];
  const data = [];
  const form = [];

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') { const h = headerFrom(next()); if (h) headers.push(h); }
    else if (CURL_DATA_FLAGS.has(a)) {
      let value = next();
      if (a === '--data-urlencode') {
        // Forms: "content", "=content", "name=content", "name@file" (file can't be read here).
        const eq = value.indexOf('=');
        const at = value.indexOf('@');
        if (value.startsWith('=')) value = encodeURIComponent(value.slice(1));
        else if (eq !== -1) value = `${value.slice(0, eq + 1)}${encodeURIComponent(value.slice(eq + 1))}`;
        else if (at !== -1) value = `${value.slice(0, at)}=`;
        else value = encodeURIComponent(value);
      }
      if (a === '--json') json = true;
      data.push(value);
    }
    else if (a === '-F' || a === '--form') form.push(next());
    else if (a === '-I' || a === '--head') method = method || 'HEAD';
    else if (a === '-T' || a === '--upload-file') { next(); upload = true; }
    else if (a === '-b' || a === '--cookie') headers.push({ name: 'Cookie', value: next() });
    else if (a === '-A' || a === '--user-agent') headers.push({ name: 'User-Agent', value: next() });
    else if (a === '-e' || a === '--referer') headers.push({ name: 'Referer', value: next() });
    else if (a === '-u' || a === '--user') headers.push({ name: 'Authorization', value: `Basic ${base64Utf8(next())}` });
    else if (a === '--oauth2-bearer') headers.push({ name: 'Authorization', value: `Bearer ${next()}` });
    else if (a === '-r' || a === '--range') headers.push({ name: 'Range', value: `bytes=${next()}` });
    else if (a === '-G' || a === '--get') asGet = true;
    else if (a === '--url') url = next();
    else if (CURL_VALUE_FLAGS.has(a)) i++;
    else if (a.startsWith('--') && a.includes('=')) {
      // --header=value / --data=value forms
      const eq = a.indexOf('=');
      args.splice(i + 1, 0, a.slice(eq + 1));
      args[i] = a.slice(0, eq);
      i--;
    }
    else if (!a.startsWith('-') && !url) url = a;
  }

  let body = data.join('&');
  if (asGet && body) {
    url += (url.includes('?') ? '&' : '?') + body;
    body = '';
  }
  const has = (name) => headers.some((h) => h.name.toLowerCase() === name);
  if (form.length) {
    const boundary = '----PostcatFormBoundary7MA4YWxkTrZu0gW';
    body = multipartBody(form, boundary);
    if (!has('content-type')) headers.push({ name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}` });
  } else if (json) {
    if (!has('content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
    if (!has('accept')) headers.push({ name: 'Accept', value: 'application/json' });
  } else if (body && !has('content-type')) {
    // curl's default for -d.
    headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
  }
  const defaultMethod = upload ? 'PUT' : (data.length || form.length) && !asGet ? 'POST' : 'GET';
  return { method: method || defaultMethod, url, headers, body };
}
