import { base64ToBytes, bytesToBase64 } from './body.js';

const VERSION = 1;
const FIELDS = ['version', 'salt', 'iv', 'ciphertext'];
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ITERATIONS = 600_000;
const AES = { name: 'AES-GCM', length: 256 };

function decodeBase64(value, length) {
  if (typeof value !== 'string') return null;
  if (length !== undefined && value.length !== 4 * Math.ceil(length / 3)) return null;
  try {
    const bytes = base64ToBytes(value);
    if (length !== undefined && bytes.length !== length) return null;
    // atob accepts whitespace, missing padding and nonzero padding bits. Store one exact encoding.
    return bytesToBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function decodeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (Reflect.ownKeys(record).length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(record, field))) return null;
  if (record.version !== VERSION) return null;
  const salt = decodeBase64(record.salt, SALT_BYTES);
  const iv = decodeBase64(record.iv, IV_BYTES);
  if (!salt || !iv) return null;
  const ciphertext = decodeBase64(record.ciphertext);
  // The smallest valid plaintext is an empty JSON array, followed by the GCM authentication tag.
  if (!ciphertext || ciphertext.length < 2 + TAG_BYTES) return null;
  return { salt, iv, ciphertext };
}

export function isVaultRecord(record) {
  return decodeRecord(record) !== null;
}

async function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || !passphrase.length) throw new TypeError('A collection passphrase is required.');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS };
  return crypto.subtle.deriveKey(params, material, AES, false, ['encrypt', 'decrypt']);
}

export async function createVault(passphrase, records) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt);
  const record = await sealVault(key, bytesToBase64(salt), records);
  return { key, record };
}

export async function openVault(passphrase, record) {
  const decoded = decodeRecord(record);
  if (!decoded) throw new TypeError('Invalid encrypted collection.');
  const { salt, iv, ciphertext } = decoded;
  const key = await deriveKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt({ name: AES.name, iv }, key, ciphertext);
  let records;
  try {
    records = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new TypeError('Invalid encrypted collection payload.');
  }
  if (!Array.isArray(records)) throw new TypeError('Invalid encrypted collection payload.');
  return { key, records };
}

// Use the salt from the existing record with the in-memory key returned by createVault/openVault.
export async function sealVault(key, salt, records) {
  if (!Array.isArray(records)) throw new TypeError('The collection must be an array.');
  if (!decodeBase64(salt, SALT_BYTES)) throw new TypeError('Invalid collection salt.');
  if (key?.algorithm?.name !== AES.name || key.algorithm.length !== AES.length || key.extractable !== false) {
    throw new TypeError('Invalid collection key.');
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(records));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: AES.name, iv }, key, plaintext);
  return { version: VERSION, salt, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}
