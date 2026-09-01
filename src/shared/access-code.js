export const ACCESS_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encoder = new TextEncoder();

class AccessCodeError extends Error {
  constructor() {
    super('Access code is invalid.');
    this.name = 'AccessCodeError';
    this.code = 'RA_CODE_INVALID';
  }
}

const fail = () => { throw new AccessCodeError(); };

const checkSymbolsFor = async (dataSymbols) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`RA-CODE-V1:${dataSymbols}`)));
  return `${ACCESS_CODE_ALPHABET[digest[0] >>> 3]}${ACCESS_CODE_ALPHABET[((digest[0] & 0x07) << 2) | (digest[1] >>> 6)]}`;
};

const resultFor = (dataSymbols, checkSymbols) => ({
  normalized: `${dataSymbols}${checkSymbols}`,
  display: `${dataSymbols.match(/.{5}/g).join('-')}-${checkSymbols}`,
  dataSymbols,
  checkSymbols,
  passwordBytes: encoder.encode(dataSymbols),
});

export const encodeAccessCode = async (entropyBytes) => {
  if (!(entropyBytes instanceof Uint8Array) || entropyBytes.byteLength !== 25) fail();
  let accumulator = 0;
  let availableBits = 0;
  let dataSymbols = '';
  for (const byte of entropyBytes) {
    accumulator = (accumulator << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5) {
      availableBits -= 5;
      dataSymbols += ACCESS_CODE_ALPHABET[(accumulator >>> availableBits) & 0x1f];
      accumulator &= (1 << availableBits) - 1;
    }
  }
  if (availableBits !== 0 || dataSymbols.length !== 40) fail();
  return resultFor(dataSymbols, await checkSymbolsFor(dataSymbols));
};

export const generateAccessCode = async () => {
  const entropy = crypto.getRandomValues(new Uint8Array(25));
  try {
    return await encodeAccessCode(entropy);
  } finally {
    entropy.fill(0);
  }
};

export const normalizeAccessCode = async (input) => {
  if (typeof input !== 'string') fail();
  let normalized = '';
  for (const character of input) {
    if (character === ' ' || character === '-') continue;
    const code = character.codePointAt(0);
    normalized += code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : character;
  }
  if (normalized.length !== 42) fail();
  for (const character of normalized) if (!ACCESS_CODE_ALPHABET.includes(character)) fail();
  const dataSymbols = normalized.slice(0, 40);
  const suppliedCheck = normalized.slice(40);
  const expectedCheck = await checkSymbolsFor(dataSymbols);
  let difference = 0;
  for (let index = 0; index < 2; index += 1) difference |= suppliedCheck.charCodeAt(index) ^ expectedCheck.charCodeAt(index);
  if (difference !== 0) fail();
  return resultFor(dataSymbols, suppliedCheck);
};
