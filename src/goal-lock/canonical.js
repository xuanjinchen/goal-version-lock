import { createHash } from 'node:crypto';

function canonicalError(message) {
  return new TypeError(`Invalid canonical JSON: ${message}`);
}

function normalizeValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) {
      throw canonicalError('numbers must be finite and integers must be safe');
    }
    return value;
  }

  if (typeof value !== 'object') {
    throw canonicalError('values must be JSON primitives, arrays, or plain objects');
  }

  if (seen.has(value)) {
    throw canonicalError('cyclic values are not supported');
  }
  seen.add(value);

  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw canonicalError('symbol keys are not supported');
    }
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw canonicalError('sparse arrays are not supported');
      }
      return value.map((entry) => normalizeValue(entry, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw canonicalError('objects must have Object.prototype or null as their prototype');
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeValue(value[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  // 在字符串化前筛除 JSON.stringify 会悄悄改写或丢弃的值，避免摘要失真。
  const normalized = normalizeValue(value, new Set());
  return `${JSON.stringify(normalized)}\n`;
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function parseCanonicalJson(bytes, label = 'document') {
  if (Buffer.from(bytes).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw canonicalError(`${label} must not include a UTF-8 BOM`);
  }

  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw canonicalError(`${label} is not valid UTF-8`);
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw canonicalError(`${label} is not valid JSON`);
  }

  if (!Buffer.from(source, 'utf8').equals(canonicalBytes(value))) {
    throw canonicalError(`${label} is not canonical`);
  }
  return value;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function shortFingerprint(digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw canonicalError('digest must be 64 lowercase hexadecimal characters');
  }
  return digest.slice(0, 12);
}
