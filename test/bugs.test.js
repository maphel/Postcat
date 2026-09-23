// Regression tests for the bugfix sprint (2026-09-23).
import test from 'node:test';
import assert from 'node:assert';
import * as lib from '../src/lib/index.js';

test('prettyBody keeps big integers and number spelling exactly', () => {
  const raw = '{"id":12345678901234567890,"price":1.10,"neg":-0,"exp":1E+2,"s":"a\\"b"}';
  assert.strictEqual(lib.prettyBody(raw),
    '{\n  "id": 12345678901234567890,\n  "price": 1.10,\n  "neg": -0,\n  "exp": 1E+2,\n  "s": "a\\"b"\n}');
});

test('prettyBody: empty containers, nesting, whitespace inside strings untouched', () => {
  assert.strictEqual(lib.prettyBody('{"a":[],"b":{},"c":[1,{"d":" x , y : [ ] "}]}'),
    '{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    {\n      "d": " x , y : [ ] "\n    }\n  ]\n}');
  assert.strictEqual(lib.prettyBody('  [ 1 ,\n 2 ]  '), '[\n  1,\n  2\n]');
  assert.strictEqual(lib.prettyBody('{bad json'), '{bad json');
});

test('paramsToUrl keeps untouched params byte-for-byte', () => {
  const url = 'https://a.test/s?q=a+b&x=%2B1&sort=name%2Casc';
  const params = lib.urlToParams(url);
  assert.strictEqual(lib.paramsToUrl(url, params), url);
  // Editing one param re-encodes only that one.
  params[2] = { ...params[2], value: 'date desc' };
  assert.strictEqual(lib.paramsToUrl(url, params), 'https://a.test/s?q=a+b&x=%2B1&sort=date%20desc');
});

test('compileFilter ignores stateful g/y flags', () => {
  const f = lib.compileFilter('/users/g');
  const item = { method: 'GET', url: 'https://a.test/users' };
  assert.deepStrictEqual([f(item), f(item), f(item)], [true, true, true]);
});

test('parseCurl: empty --data-raw still means POST', () => {
  assert.strictEqual(lib.parseCurl("curl https://a.test --data-raw ''").method, 'POST');
});

// ---------- sprint 2 ----------

test('jsonError survives absurd nesting depth', () => {
  const e = lib.jsonError('['.repeat(20000));
  assert.ok(e && typeof e.message === 'string' && e.line === 1);
});

test('jsonError names astral characters properly', () => {
  assert.strictEqual(lib.jsonError('{"a": 😀}').message, "Unexpected '😀'");
});

test('UTF-16 text is text, not an MP3; charset is honoured', () => {
  const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  assert.notStrictEqual(lib.sniffMime(utf16), 'audio/mpeg');
  const d = lib.describeBody({ bytes: utf16, mime: 'application/octet-stream' });
  assert.deepStrictEqual([d.kind, d.text], ['text', 'hi']);
  const latin = lib.describeBody({ bytes: new Uint8Array([0x68, 0xe4]), mime: 'text/html; charset=iso-8859-1' });
  assert.strictEqual(latin.text, 'hä');
  const bogus = lib.describeBody({ bytes: new Uint8Array([0x68, 0x69]), mime: 'text/plain; charset=no-such-charset' });
  assert.strictEqual(bogus.text, 'hi');
  // A real MP3 frame header still sniffs as audio.
  assert.strictEqual(lib.sniffMime(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0])), 'audio/mpeg');
});

test('parseCurl: value flags never eat the URL; special flags map to headers/methods', () => {
  assert.strictEqual(lib.parseCurl('curl -c jar.txt -D h.txt --max-redirs 5 https://a.test').url, 'https://a.test');
  const bearer = lib.parseCurl('curl --oauth2-bearer TOK https://a.test');
  assert.deepStrictEqual(bearer.headers, [{ name: 'Authorization', value: 'Bearer TOK' }]);
  assert.deepStrictEqual(lib.parseCurl('curl -r 0-99 https://a.test').headers, [{ name: 'Range', value: 'bytes=0-99' }]);
  assert.strictEqual(lib.parseCurl('curl -I https://a.test').method, 'HEAD');
  assert.strictEqual(lib.parseCurl('curl -T file.bin https://a.test').method, 'PUT');
  const form = lib.parseCurl('curl -F a=1 -F "f=@photo.jpg" https://a.test');
  assert.strictEqual(form.method, 'POST');
  assert.match(form.headers.find((h) => h.name === 'Content-Type').value, /^multipart\/form-data; boundary=/);
  assert.match(form.body, /name="a"\r\n\r\n1\r\n/);
  assert.match(form.body, /name="f"; filename="photo.jpg"/);
});

test('parseCurl: Windows cmd quoting from Chrome', () => {
  const cmd = 'curl "https://a.test/?x=1^&y=2" ^\r\n  -H "accept: */*" ^\r\n  --data-raw "^{\\"name\\":\\"x\\"^}"';
  const r = lib.parseCurl(cmd);
  assert.strictEqual(r.url, 'https://a.test/?x=1&y=2');
  assert.strictEqual(r.body, '{"name":"x"}');
  assert.deepStrictEqual(r.headers.filter((h) => h.name === 'accept'), [{ name: 'accept', value: '*/*' }]);
  const wrapped = lib.parseCurl('curl ^"https://a.test/^" ^\n  -H ^"accept: text/html^"');
  assert.strictEqual(wrapped.url, 'https://a.test/');
  assert.deepStrictEqual(wrapped.headers, [{ name: 'accept', value: 'text/html' }]);
});

test('parseCurl: --data-urlencode forms, unicode -u, curl.exe and paths', () => {
  assert.strictEqual(lib.parseCurl("curl https://a.test --data-urlencode '=a b'").body, 'a%20b');
  assert.strictEqual(lib.parseCurl("curl https://a.test --data-urlencode 'n@f.txt'").body, 'n=');
  assert.strictEqual(lib.parseCurl("curl -u '€:x' https://a.test").headers[0].value, `Basic ${Buffer.from('€:x').toString('base64')}`);
  assert.strictEqual(lib.parseCurl('/usr/bin/curl https://a.test').url, 'https://a.test');
  assert.strictEqual(lib.parseCurl('curl.exe https://a.test').url, 'https://a.test');
  assert.strictEqual(lib.parseCurl('wget https://a.test'), null);
});

test('formatBody / prettyBody ignore a BOM', () => {
  assert.deepStrictEqual(lib.formatBody('﻿{"a":1}'), { text: '{\n  "a": 1\n}', json: true });
});

test('formatBytes / formatTime round to the right unit', () => {
  assert.strictEqual(lib.formatBytes(1048570), '1.0 MB');
  assert.strictEqual(lib.formatBytes(1023.9), '1.0 KB');
  assert.strictEqual(lib.formatBytes(NaN), '');
  assert.strictEqual(lib.formatTime(999.6), '1.00 s');
  assert.strictEqual(lib.formatTime(NaN), '');
});

test('fileNameFor: bad percent-encoding, version-like paths', () => {
  assert.strictEqual(lib.fileNameFor('https://a.test/dl/100%.pdf', 'application/pdf'), '100%.pdf');
  assert.strictEqual(lib.fileNameFor('https://a.test/api/v1.2', 'application/json'), 'v1.2.json');
});

test('textToRows treats // lines as disabled, like parseHeaders', () => {
  assert.deepStrictEqual(lib.textToRows('// X: 1'), [{ enabled: false, key: 'X', value: '1' }]);
  assert.strictEqual(lib.rowsToText([{ enabled: true, key: '', value: 'v' }]), '');
});

test('fetchErrorMessage never prints [object Object]', () => {
  assert.strictEqual(lib.fetchErrorMessage({}, 'https://a.test'), 'Unknown error');
  assert.strictEqual(lib.fetchErrorMessage(new Error(''), 'https://a.test'), 'Error');
  assert.strictEqual(lib.fetchErrorMessage('boom', 'https://a.test'), 'boom');
});

test('toCurl exports empty header values the way curl needs them', () => {
  assert.match(lib.toCurl({ method: 'GET', url: 'https://a.test', headers: [{ name: 'X', value: '' }], body: '' }), /-H 'X;'/);
});
