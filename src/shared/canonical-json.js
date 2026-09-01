const scalar = (value) => {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && (index + 1 >= value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff)) throw new TypeError('RA_CANONICAL_LONE_SURROGATE');
      if (code >= 0xdc00 && code <= 0xdfff && (index === 0 || value.charCodeAt(index - 1) < 0xd800 || value.charCodeAt(index - 1) > 0xdbff)) throw new TypeError('RA_CANONICAL_LONE_SURROGATE');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('RA_CANONICAL_NONFINITE');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || value === null) return JSON.stringify(value);
  throw new TypeError('RA_CANONICAL_UNSUPPORTED');
};

/** RFC 8785-compatible canonical JSON for the supported JSON domain. */
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${scalar(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return scalar(value);
};

export const canonicalUtf8 = (value) => new TextEncoder().encode(canonicalJson(value));
