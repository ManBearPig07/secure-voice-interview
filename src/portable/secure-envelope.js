import { canonicalJson } from '../shared/canonical-json.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DOMAINS = new Set(['PROMPT', 'RECORD']);

const fail = () => { throw new Error('RA_PORTABLE_ENVELOPE_INVALID'); };
const bytes = (value) => {
  if (!(value instanceof Uint8Array)) fail();
  return value;
};
const base64urlEncode = (value) => {
  const source = bytes(value);
  let binary = '';
  for (let offset = 0; offset < source.length; offset += 0x8000) {
    binary += String.fromCharCode(...source.subarray(offset, Math.min(offset + 0x8000, source.length)));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
const base64urlDecode = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) fail();
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  let binary;
  try { binary = atob(padded); } catch { fail(); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
const exactHeader = (value) => {
  const keys = ['envelope_version', 'release_id', 'object_id', 'object_kind'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.envelope_version !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.release_id)
    || typeof value.object_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.object_id)
    || !['PROMPT', 'STATE', 'AUDIO', 'DRAFT_CHUNK'].includes(value.object_kind)) fail();
  return value;
};

export const derivePortableKey = async ({ passwordBytes, salt, iterations, domain } = {}) => {
  bytes(passwordBytes); bytes(salt);
  if (passwordBytes.length !== 40 || salt.length < 16 || salt.length > 64
    || !Number.isSafeInteger(iterations) || iterations < 1000 || iterations > 2_000_000
    || !DOMAINS.has(domain)) fail();
  let root = null;
  try {
    const passwordKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
    root = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, passwordKey, 256));
    const hkdfKey = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt,
      info: encoder.encode(`RA-PORTABLE-${domain}-V1`),
    }, hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } catch { fail(); }
  finally { root?.fill(0); }
};

export const sealPortableEnvelope = async ({ key, header, plaintext, iv } = {}) => {
  exactHeader(header); bytes(plaintext); bytes(iv);
  if (iv.length !== 12 || plaintext.length > 136 * 1024 * 1024) fail();
  const aad = encoder.encode(canonicalJson(header));
  let sealed;
  try { sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext)); }
  catch { fail(); }
  return Object.freeze({ header: structuredClone(header), iv_b64: base64urlEncode(iv), ciphertext_b64: base64urlEncode(sealed) });
};

export const openPortableEnvelope = async ({ key, envelope, expectedHeader } = {}) => {
  const keys = ['header', 'iv_b64', 'ciphertext_b64'];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).length !== keys.length || keys.some((name) => !Object.hasOwn(envelope, name))) fail();
  exactHeader(envelope.header);
  if (expectedHeader && canonicalJson(envelope.header) !== canonicalJson(exactHeader(expectedHeader))) fail();
  const iv = base64urlDecode(envelope.iv_b64);
  const ciphertext = base64urlDecode(envelope.ciphertext_b64);
  if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > 136 * 1024 * 1024 + 16) fail();
  const aad = encoder.encode(canonicalJson(envelope.header));
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext)); }
  catch { fail(); }
};

export const encodePortableBase64 = base64urlEncode;
export const decodePortableBase64 = base64urlDecode;
export const decodePortableUtf8 = (value) => decoder.decode(bytes(value));
