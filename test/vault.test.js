import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createVault, isVaultRecord, openVault, sealVault } from '../src/lib/vault.js';

const passphrase = ' test 🔐 collection café ';
const records = [{
  name: 'Request 🐈', method: 'POST', url: 'https://example.test/resource?q=caf%C3%A9',
  headersText: 'Authorization: Bearer test-secret', body: '{"message":"こんにちは","id":12345678901234567890}',
}];

function referenceRecord(plaintext) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 600_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

test('createVault round trips requests and exposes only a nonextractable key in memory', async () => {
  const { key, record } = await createVault(passphrase, records);
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'iv', 'salt', 'version']);
  assert.equal(record.version, 1);
  assert.equal(Buffer.from(record.salt, 'base64').length, 16);
  assert.equal(Buffer.from(record.iv, 'base64').length, 12);
  assert.equal(Buffer.from(record.ciphertext, 'base64').length, Buffer.byteLength(JSON.stringify(records)) + 16);
  assert.ok(isVaultRecord(JSON.parse(JSON.stringify(record))));
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
  const opened = await openVault(passphrase, record);
  assert.equal(opened.key.extractable, false);
  assert.deepEqual(opened.records, records);
});

test('independent vaults have fresh salts and subsequent saves have fresh IVs', async () => {
  const [a, b] = await Promise.all([createVault(passphrase, []), createVault(passphrase, [])]);
  assert.notEqual(a.record.salt, b.record.salt);
  const saved = await sealVault(a.key, a.record.salt, []);
  assert.equal(saved.salt, a.record.salt);
  assert.notEqual(saved.iv, a.record.iv);
  assert.notEqual(saved.ciphertext, a.record.ciphertext);
  assert.equal(Buffer.from(saved.ciphertext, 'base64').length, 18);
  assert.deepEqual((await openVault(passphrase, saved)).records, []);
});

test('vault format interoperates with Node PBKDF2 and AES-GCM', async () => {
  const original = referenceRecord(JSON.stringify(records));
  const { key, records: opened } = await openVault(passphrase, original);
  assert.deepEqual(opened, records);
  const sealed = await sealVault(key, original.salt, opened);
  const derived = pbkdf2Sync(passphrase, Buffer.from(sealed.salt, 'base64'), 600_000, 32, 'sha256');
  const ciphertext = Buffer.from(sealed.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')), records);
});

test('vault refuses wrong passphrases and tampered salt, IV, ciphertext or tag', async () => {
  const { record } = await createVault(passphrase, records);
  await assert.rejects(openVault(passphrase.trim(), record));
  for (const [field, at] of [['salt', 0], ['iv', 0], ['ciphertext', 0], ['ciphertext', -1]]) {
    const bytes = Buffer.from(record[field], 'base64');
    bytes[at < 0 ? bytes.length + at : at] ^= 1;
    const tampered = { ...record, [field]: bytes.toString('base64') };
    assert.ok(isVaultRecord(tampered), field);
    await assert.rejects(openVault(passphrase, tampered), field);
  }
});

test('vault envelope validation rejects other versions, fields, encodings and lengths', async () => {
  const structural = {
    version: 1,
    salt: Buffer.alloc(16).toString('base64'),
    iv: Buffer.alloc(12).toString('base64'),
    ciphertext: Buffer.alloc(18).toString('base64'),
  };
  assert.ok(isVaultRecord(structural));
  for (const malformed of [
    null, undefined, [], {}, 'encrypted',
    { ...structural, version: 2 }, { ...structural, version: '1' },
    { ...structural, key: 'unexpected' }, { ...structural, salt: null },
    { ...structural, salt: structural.salt.slice(0, -2) },
    { ...structural, salt: `${structural.salt.slice(0, -3)}B==` },
    { ...structural, salt: Buffer.alloc(15).toString('base64') },
    { ...structural, iv: Buffer.alloc(11).toString('base64') },
    { ...structural, iv: '*' + structural.iv.slice(1) },
    { ...structural, ciphertext: Buffer.alloc(17).toString('base64') },
    { ...structural, ciphertext: `${structural.ciphertext}\n` },
    { version: 1, salt: structural.salt, iv: structural.iv },
  ]) {
    assert.equal(isVaultRecord(malformed), false, JSON.stringify(malformed));
    await assert.rejects(openVault(passphrase, malformed), /Invalid encrypted collection/);
  }
});

test('valid authentication does not make invalid UTF-8, JSON or non-array data acceptable', async () => {
  for (const payload of [Buffer.from([0x5b, 0xff, 0x5d]), '[unclosed', '{"records":[]}']) {
    const record = referenceRecord(payload);
    assert.ok(isVaultRecord(record));
    await assert.rejects(openVault(passphrase, record), /Invalid encrypted collection payload/);
  }
});

test('vault rejects invalid passphrase, collection input, salt and key type', async () => {
  for (const invalid of ['', null, 123]) await assert.rejects(createVault(invalid, []), /passphrase/);
  const { key, record } = await createVault(passphrase, []);
  await assert.rejects(createVault(passphrase, {}), /array/);
  await assert.rejects(openVault('', record), /passphrase/);
  await assert.rejects(sealVault(key, record.salt, null), /array/);
  await assert.rejects(sealVault(key, 'not base64', []), /salt/);
  for (const [length, extractable] of [[128, false], [256, true]]) {
    const foreign = await crypto.subtle.generateKey({ name: 'AES-GCM', length }, extractable, ['encrypt', 'decrypt']);
    await assert.rejects(sealVault(foreign, record.salt, []), /key/);
  }
});
