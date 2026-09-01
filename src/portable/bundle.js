import { canonicalJson } from '../shared/canonical-json.js';
import { decodePortableBase64, encodePortableBase64 } from './secure-envelope.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const RECORD_KEY = /^(?:state|audio:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const KDF_PROFILES = new Map([['FIXTURE_NON_PRODUCTION', 1000], ['PORTABLE_RELEASE_CANDIDATE_V1', 600000]]);
const fail = () => { throw new Error('RA_PORTABLE_BUNDLE_INVALID'); };
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((value) => value.toString(16).padStart(2, '0')).join('');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const decoded = (value) => {
  try {
    const result = decodePortableBase64(value);
    if (encodePortableBase64(result) !== value) fail();
    return result;
  } catch { fail(); }
};
const validateEnvelope = (envelope, releaseId, objectId, objectKind, maximumPlaintextBytes) => {
  if (!exact(envelope, ['header','iv_b64','ciphertext_b64'])
    || !exact(envelope.header, ['envelope_version','release_id','object_id','object_kind'])
    || envelope.header.envelope_version !== 1 || envelope.header.release_id !== releaseId
    || envelope.header.object_id !== objectId || envelope.header.object_kind !== objectKind) fail();
  const iv = decoded(envelope.iv_b64);
  const ciphertext = decoded(envelope.ciphertext_b64);
  if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > maximumPlaintextBytes + 16) fail();
};
const validateKdf = (kdf) => {
  if (!exact(kdf, ['profile_id','iterations','salt_b64'])
    || KDF_PROFILES.get(kdf.profile_id) !== kdf.iterations
    || decoded(kdf.salt_b64).length !== 32) fail();
};
const validateBundleValue = (value) => {
  if (!exact(value, ['created_at','kdf','portable_bundle_schema_version','prompt_envelope','records','release_id'])
    || value.portable_bundle_schema_version !== 1 || !UUID.test(value.release_id)
    || !TIMESTAMP.test(value.created_at) || !Array.isArray(value.records)
    || value.records.length < 1 || value.records.length > 52
    || new Set(value.records.map((item) => item?.key)).size !== value.records.length
    || value.records.map((item) => item?.key).join('\n') !== value.records.map((item) => item?.key).sort().join('\n')) fail();
  validateKdf(value.kdf);
  validateEnvelope(value.prompt_envelope, value.release_id, 'prompt', 'PROMPT', 4 * 1024 * 1024);
  let stateCount = 0;
  for (const record of value.records) {
    if (!exact(record, ['key','envelope']) || !RECORD_KEY.test(record.key)) fail();
    if (record.key === 'state') {
      stateCount += 1;
      validateEnvelope(record.envelope, value.release_id, 'state', 'STATE', 1024 * 1024);
    } else {
      const objectId = record.key.slice('audio:'.length);
      validateEnvelope(record.envelope, value.release_id, objectId, 'AUDIO', 2_000_000);
    }
  }
  if (stateCount !== 1) fail();
  return value;
};

export const createPortableBundle = ({ releaseId, kdf, promptEnvelope, records, createdAt } = {}) => {
  const value = {
    portable_bundle_schema_version: 1, release_id: releaseId, created_at: createdAt,
    kdf: structuredClone(kdf), prompt_envelope: structuredClone(promptEnvelope),
    records: records.map((item) => ({ key: item.key, envelope: structuredClone(item.envelope) })).sort((a, b) => a.key.localeCompare(b.key)),
  };
  return encoder.encode(canonicalJson(validateBundleValue(value)));
};

export const parsePortableBundle = (bundleBytes) => {
  if (!(bundleBytes instanceof Uint8Array) || bundleBytes.length < 2 || bundleBytes.length > 160 * 1024 * 1024) fail();
  let value;
  try { value = JSON.parse(decoder.decode(bundleBytes)); } catch { fail(); }
  if (canonicalJson(value) !== decoder.decode(bundleBytes)) fail();
  return validateBundleValue(value);
};

export const createPortableReceipt = async ({ bundleBytes, releaseId, createdAt } = {}) => {
  const bundle = parsePortableBundle(bundleBytes);
  if (bundle.release_id !== releaseId || bundle.created_at !== createdAt) fail();
  const value = {
    receipt_version: 1, release_id: releaseId, bundle_sha256: await sha256(bundleBytes),
    bundle_byte_length: bundleBytes.length, created_device_timestamp_and_timezone_offset: createdAt,
  };
  return { value, bytes: encoder.encode(canonicalJson(value)) };
};

export const verifyPortableReceipt = async ({ bundleBytes, receiptBytes } = {}) => {
  const bundle = parsePortableBundle(bundleBytes);
  if (!(receiptBytes instanceof Uint8Array) || receiptBytes.length > 4096) fail();
  let receipt;
  try { receipt = JSON.parse(decoder.decode(receiptBytes)); } catch { fail(); }
  if (canonicalJson(receipt) !== decoder.decode(receiptBytes)
    || !exact(receipt, ['bundle_byte_length','bundle_sha256','created_device_timestamp_and_timezone_offset','receipt_version','release_id'])
    || receipt.receipt_version !== 1 || receipt.release_id !== bundle.release_id
    || !HASH.test(receipt.bundle_sha256) || receipt.bundle_byte_length !== bundleBytes.length
    || receipt.created_device_timestamp_and_timezone_offset !== bundle.created_at
    || receipt.bundle_sha256 !== await sha256(bundleBytes)) fail();
  return receipt;
};
