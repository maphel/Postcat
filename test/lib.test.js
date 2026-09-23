import test from 'node:test';
import assert from 'node:assert';
import * as lib from '../src/lib/index.js';

test('parseHeaders skips blanks and comments and splits on first colon', () => {
  const h = lib.parseHeaders('Accept: application/json\n\n# X-Off: 1\n// X-Off2: 1\nX-Time: 12:30\nbroken');
  assert.deepStrictEqual(h, [
    { name: 'Accept', value: 'application/json' },
    { name: 'X-Time', value: '12:30' },
  ]);
});

test('headersToText round-trips with parseHeaders', () => {
  const h = [{ name: 'A', value: '1' }, { name: 'B', value: 'x: y' }];
  assert.deepStrictEqual(lib.parseHeaders(lib.headersToText(h)), h);
});

test('fromHarEntry drops HTTP/2 pseudo headers and keeps body', () => {
  const item = lib.fromHarEntry({
    startedDateTime: 't', time: 12, _resourceType: 'fetch',
    request: { method: 'POST', url: 'https://a.test/x', headers: [{ name: ':authority', value: 'a.test' }, { name: 'content-type', value: 'application/json' }], postData: { text: '{"a":1}' } },
    response: { status: 201, statusText: 'Created', headers: [], content: { size: 5, mimeType: 'application/json' } },
  });
  assert.strictEqual(item.headersText, 'content-type: application/json');
  assert.strictEqual(item.body, '{"a":1}');
  assert.strictEqual(item.recorded.status, 201);
});

test('isXhrLike keeps xhr/fetch and unknown types', () => {
  assert.ok(lib.isXhrLike({ _resourceType: 'xhr' }));
  assert.ok(lib.isXhrLike({ _resourceType: 'fetch' }));
  assert.ok(lib.isXhrLike({}));
  assert.ok(!lib.isXhrLike({ _resourceType: 'image' }));
});

test('compileFilter: substring, regex, invalid regex falls back', () => {
  const item = { method: 'POST', url: 'https://api.test/users/42' };
  assert.strictEqual(lib.compileFilter('  '), null);
  assert.ok(lib.compileFilter('USERS')(item));
  assert.ok(lib.compileFilter('/^POST .*\\/users\\/\\d+$/')(item));
  assert.ok(!lib.compileFilter('/^GET/')(item));
  assert.ok(!lib.compileFilter('/(/')(item));
});

test('toCurl escapes single quotes', () => {
  const curl = lib.toCurl({ method: 'POST', url: 'https://a.test', headers: [{ name: 'X', value: "it's" }], body: "{'a':1}" });
  assert.strictEqual(curl, "curl -X POST 'https://a.test' \\\n  -H 'X: it'\\''s' \\\n  --data-raw '{'\\''a'\\'':1}'");
});

test('prettyBody formats JSON and leaves other text alone', () => {
  assert.strictEqual(lib.prettyBody('{"a":1}'), '{\n  "a": 1\n}');
  assert.strictEqual(lib.prettyBody('hello'), 'hello');
  assert.strictEqual(lib.prettyBody('{broken'), '{broken');
});

test('textToRows/rowsToText keep disabled lines', () => {
  const rows = lib.textToRows('Accept: */*\n# X-Off: 1\n\nbroken');
  assert.deepStrictEqual(rows, [
    { enabled: true, key: 'Accept', value: '*/*' },
    { enabled: false, key: 'X-Off', value: '1' },
    { enabled: true, key: 'broken', value: '' },
  ]);
  assert.strictEqual(lib.rowsToText(rows.slice(0, 2)), 'Accept: */*\n# X-Off: 1');
  // Disabled rows are not sent.
  assert.deepStrictEqual(lib.parseHeaders(lib.rowsToText(rows.slice(0, 2))), [{ name: 'Accept', value: '*/*' }]);
});

test('urlToParams / paramsToUrl round-trip and keep the hash', () => {
  const url = 'https://a.test/p?q=hello%20world&flag&x=%7Bid%7D#top';
  const params = lib.urlToParams(url);
  assert.deepStrictEqual(params.map(({ key, value }) => ({ key, value })), [
    { key: 'q', value: 'hello world' }, { key: 'flag', value: '' }, { key: 'x', value: '{id}' },
  ]);
  assert.strictEqual(lib.paramsToUrl(url, params), url.replace('#top', '') + '#top');
  // Params without raw (typed by the user) are encoded, keeping {placeholders} readable.
  assert.strictEqual(lib.paramsToUrl(url, params.map(({ key, value }) => ({ key, value }))), 'https://a.test/p?q=hello%20world&flag&x={id}#top');
  assert.strictEqual(lib.paramsToUrl(url, []), 'https://a.test/p#top');
  assert.strictEqual(lib.paramsToUrl('https://a.test', [{ key: 'a', value: '1&2' }]), 'https://a.test?a=1%262');
});

test('urlToParams survives malformed percent-encoding', () => {
  assert.deepStrictEqual(lib.urlToParams('https://a.test?x=%E0%A4%A'), [{ key: 'x', value: '%E0%A4%A', raw: 'x=%E0%A4%A' }]);
});

test('shellSplit handles quotes, $-strings and line continuations', () => {
  assert.deepStrictEqual(lib.shellSplit(`curl 'a b' "c \\"d\\"" $'e\\'f\\ng' h\\ i \\\n  -k`),
    ['curl', 'a b', 'c "d"', "e'f\ng", 'h i', '-k']);
});

test('parseCurl: Chrome "Copy as cURL" output', () => {
  const cmd = `curl 'https://api.test/users?page=2' \\
  -H 'accept: application/json' \\
  -b 'sid=abc; theme=dark' \\
  -H 'content-type: application/json' \\
  --data-raw $'{"name":"it\\'s"}' \\
  --compressed`;
  assert.deepStrictEqual(lib.parseCurl(cmd), {
    method: 'POST',
    url: 'https://api.test/users?page=2',
    headers: [
      { name: 'accept', value: 'application/json' },
      { name: 'Cookie', value: 'sid=abc; theme=dark' },
      { name: 'content-type', value: 'application/json' },
    ],
    body: '{"name":"it\'s"}',
  });
});

test('parseCurl: explicit method, -G, --user, form default content type', () => {
  assert.strictEqual(lib.parseCurl('curl -XDELETE https://a.test/1').method, 'DELETE');
  const get = lib.parseCurl('curl -G https://a.test/s -d q=1 -d r=2');
  assert.strictEqual(get.url, 'https://a.test/s?q=1&r=2');
  assert.strictEqual(get.method, 'GET');
  assert.strictEqual(get.body, '');
  const auth = lib.parseCurl('curl -u user:pw https://a.test');
  assert.deepStrictEqual(auth.headers, [{ name: 'Authorization', value: 'Basic dXNlcjpwdw==' }]);
  const form = lib.parseCurl('curl https://a.test -d a=1');
  assert.deepStrictEqual(form.headers, [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  assert.strictEqual(lib.parseCurl('wget https://a.test'), null);
});

test('tokenizeJson classifies keys, strings, numbers, literals', () => {
  const tokens = lib.tokenizeJson('{\n  "a": "x:y",\n  "n": -1.5e3,\n  "b": true,\n  "z": null\n}');
  const typed = tokens.filter(([c]) => c).map(([c, t]) => `${c}=${t}`);
  assert.deepStrictEqual(typed, ['j-key="a"', 'j-str="x:y"', 'j-key="n"', 'j-num=-1.5e3', 'j-key="b"', 'j-bool=true', 'j-key="z"', 'j-null=null']);
  assert.strictEqual(tokens.map(([, t]) => t).join(''), '{\n  "a": "x:y",\n  "n": -1.5e3,\n  "b": true,\n  "z": null\n}');
});

test('formatBody reports JSON-ness', () => {
  assert.deepStrictEqual(lib.formatBody('{"a":1}'), { text: '{\n  "a": 1\n}', json: true });
  assert.deepStrictEqual(lib.formatBody('<html>'), { text: '<html>', json: false });
});

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('base64 round-trip', () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  assert.deepStrictEqual(lib.base64ToBytes(lib.bytesToBase64(bytes)), bytes);
});

test('sniffMime recognises common formats', () => {
  const b = (...xs) => new Uint8Array([...xs, 0, 0, 0, 0, 0, 0, 0, 0]);
  const s = (str, pad = 8) => new Uint8Array([...str].map((c) => c.charCodeAt(0)).concat(Array(pad).fill(0)));
  assert.strictEqual(lib.sniffMime(lib.base64ToBytes(PNG_1x1)), 'image/png');
  assert.strictEqual(lib.sniffMime(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.strictEqual(lib.sniffMime(s('GIF89a')), 'image/gif');
  assert.strictEqual(lib.sniffMime(s('RIFF\0\0\0\0WEBP')), 'image/webp');
  assert.strictEqual(lib.sniffMime(s('\0\0\0\x20ftypisom')), 'video/mp4');
  assert.strictEqual(lib.sniffMime(s('\0\0\0\x1cftypavif')), 'image/avif');
  assert.strictEqual(lib.sniffMime(s('%PDF-1.7')), 'application/pdf');
  assert.strictEqual(lib.sniffMime(s('wOF2')), 'font/woff2');
  assert.strictEqual(lib.sniffMime(s('hello world')), '');
});

test('previewKind maps content types', () => {
  const cases = {
    'image/webp': 'image', 'image/svg+xml': 'svg', 'video/mp4': 'video', 'audio/mpeg': 'audio',
    'application/pdf': 'pdf', 'font/woff2': 'font', 'application/font-woff': 'font',
    'text/html; charset=utf-8': 'html', 'application/json': 'json', 'application/problem+json': 'json',
    'text/css': 'text', 'application/javascript': 'text', 'application/xml': 'text', 'application/x-ndjson': 'text',
    'application/octet-stream': 'binary', '': 'binary',
  };
  for (const [mime, kind] of Object.entries(cases)) assert.strictEqual(lib.previewKind(mime), kind, mime);
});

test('looksLikeText: utf-8 yes, binary no, cut multibyte sequence ok', () => {
  assert.ok(lib.looksLikeText(new TextEncoder().encode('hällo {"a":1}')));
  assert.ok(!lib.looksLikeText(lib.base64ToBytes(PNG_1x1)));
  const long = new TextEncoder().encode('ä'.repeat(40000)); // 80000 bytes, sample cuts inside "ä"? 65536 is even -> not cut
  assert.ok(lib.looksLikeText(long));
  const odd = new TextEncoder().encode('x' + 'ä'.repeat(40000)); // sample boundary lands mid-character
  assert.ok(lib.looksLikeText(odd));
});

test('describeBody: sniffs octet-stream, decodes text-ish binary, keeps media as bytes', () => {
  const png = lib.describeBody({ base64: PNG_1x1, mime: 'application/octet-stream' });
  assert.strictEqual(png.kind, 'image');
  assert.strictEqual(png.mime, 'image/png');
  assert.strictEqual(png.size, 70);

  const declaredWebp = lib.describeBody({ base64: PNG_1x1, mime: 'image/webp' });
  assert.strictEqual(declaredWebp.mime, 'image/webp'); // a specific header wins over sniffing

  const json = lib.describeBody({ base64: lib.bytesToBase64(new TextEncoder().encode('{"a":1}')), mime: 'application/octet-stream' });
  assert.deepStrictEqual([json.kind, json.text], ['text', '{"a":1}']);

  const svg = lib.describeBody({ text: '<svg xmlns="http://www.w3.org/2000/svg"/>', mime: 'image/svg+xml' });
  assert.strictEqual(svg.kind, 'svg');

  const plain = lib.describeBody({ text: 'hi', mime: '' });
  assert.deepStrictEqual([plain.kind, plain.text, plain.size], ['text', 'hi', 2]);
});

test('hexDump formats offset, hex and ascii columns', () => {
  const dump = lib.hexDump(new TextEncoder().encode('Hello, Postcat!\n\x01'), 1024);
  assert.strictEqual(dump.split('\n')[0], '00000000  48 65 6c 6c 6f 2c 20 50 6f 73 74 63 61 74 21 0a  |Hello, Postcat!.|');
  assert.strictEqual(dump.split('\n')[1], '00000010  01                                               |.|');
  assert.match(lib.hexDump(new Uint8Array(20), 16), /… 4 more bytes$/);
});

test('fileNameFor', () => {
  assert.strictEqual(lib.fileNameFor('https://a.test/img/cat.webp?w=200', 'image/webp'), 'cat.webp');
  assert.strictEqual(lib.fileNameFor('https://a.test/api/users/42', 'application/json; charset=utf-8'), '42.json');
  assert.strictEqual(lib.fileNameFor('https://a.test/', 'application/x-thing'), 'response.bin');
});

test('jsonError reports message, line and column', () => {
  assert.strictEqual(lib.jsonError('{"a": 1}'), null);
  const err = lib.jsonError('{\n  "a": 1,\n  "b": }');
  assert.deepStrictEqual([err.line, err.column], [3, 8]);
  assert.ok(err.message.length > 0 && !/position/.test(err.message), err.message);
  assert.deepStrictEqual(Object.keys(lib.jsonError('{')), ['message', 'line', 'column']);
});

test('expectsJson: by content type or shape', () => {
  assert.ok(lib.expectsJson('{"a":1}', 'Content-Type: application/json'));
  assert.ok(lib.expectsJson('{"a":1}', 'Accept: */*'));
  assert.ok(!lib.expectsJson('a=1&b=2', 'Content-Type: application/x-www-form-urlencoded'));
  assert.ok(!lib.expectsJson('{"a":1}', 'Content-Type: text/plain'));
  assert.ok(!lib.expectsJson('', 'Content-Type: application/json'));
  assert.ok(lib.expectsJson('oops', 'content-type: application/vnd.api+json'));
});

test('fetchErrorMessage explains common failures', () => {
  assert.strictEqual(lib.fetchErrorMessage(null, 'https://a.test', { cancelled: true }), 'Request cancelled.');
  assert.strictEqual(lib.fetchErrorMessage(null, 'https://a.test', { timedOut: true, timeoutMs: 60000 }), 'No response after 60 s — timed out.');
  assert.match(lib.fetchErrorMessage(new TypeError('Failed to fetch'), 'https://api.a.test:8443/x'), /^Couldn’t reach api\.a\.test:8443\./);
  assert.strictEqual(lib.fetchErrorMessage(new TypeError('Failed to fetch'), 'https://a.test', { online: false }), 'You’re offline.');
  assert.strictEqual(lib.fetchErrorMessage(new Error('Invalid header "X"'), 'https://a.test'), 'Invalid header "X"');
});

test('jsonError locates common mistakes', () => {
  const at = (t) => { const e = lib.jsonError(t); return `${e.line}:${e.column} ${e.message}`; };
  assert.strictEqual(at('{"a": 1,}'), "1:9 Expected a property name in double quotes, unexpected '}'");
  assert.strictEqual(at("{'a': 1}"), "1:2 Expected a property name in double quotes, unexpected '''");
  assert.strictEqual(at('{"a": 1 "b": 2}'), "1:9 Expected ',' or '}', unexpected '\"'");
  assert.strictEqual(at('[1, 2'), "1:6 Expected ',' or ']', unexpected end of input");
  assert.strictEqual(at('{"a": tru}'), "1:7 Unexpected 't'");
  assert.strictEqual(at('{"a": "x\ny"}'), '1:9 Line break or control character in string');
  assert.strictEqual(at('{} x'), '1:4 Unexpected content after the JSON value');
});
