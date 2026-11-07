/**
 * Proof of a payment made outside the book: a transaction reference, a
 * screenshot, or both. Screenshots are PNG or JPEG only, checked by their bytes
 * rather than their name, and stored with text and camera metadata removed.
 */

export const PROOF_LIMITS = {
  maxReference: 100,
  maxImageBytes: 3 * 1024 * 1024,
};

export const PROOF_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg' };

export class ProofError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROPPED = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function referenceOf(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > PROOF_LIMITS.maxReference) {
    throw new ProofError(`Keep the transaction ID under ${PROOF_LIMITS.maxReference} characters.`);
  }
  return text;
}

export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

function stripPng(bytes) {
  const kept = [PNG_SIGNATURE];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new ProofError('That PNG is damaged.');
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!PNG_DROPPED.has(type)) kept.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new ProofError('That PNG is damaged.');
  return Buffer.concat(kept);
}

/** Drops APP1 through APP15 and comments, where EXIF, GPS, and XMP live. Image data from start-of-scan on is kept as is. */
function stripJpeg(bytes) {
  const kept = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new ProofError('That JPEG is damaged.');
    const marker = bytes[offset + 1];
    if (marker === 0xda) {
      kept.push(bytes.subarray(offset));
      return Buffer.concat(kept);
    }
    const length = bytes.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) throw new ProofError('That JPEG is damaged.');
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) kept.push(bytes.subarray(offset, end));
    offset = end;
  }
  throw new ProofError('That JPEG is damaged.');
}

/** Takes { type, data } with base64 data, and returns clean bytes plus the type found in them. */
export function cleanScreenshot(input) {
  if (!input || typeof input.data !== 'string') throw new ProofError('Attach the screenshot as a PNG or JPEG.');
  if (input.data.length > Math.ceil(PROOF_LIMITS.maxImageBytes / 3) * 4 + 4) {
    throw new ProofError('Keep the screenshot under 3 MB. Crop it to the payment.', 413);
  }
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length || bytes.length > PROOF_LIMITS.maxImageBytes) {
    throw new ProofError('Keep the screenshot under 3 MB. Crop it to the payment.', 413);
  }
  const type = sniffImage(bytes);
  if (!type) throw new ProofError('Use a PNG or JPEG screenshot.');
  return { type, bytes: type === 'image/png' ? stripPng(bytes) : stripJpeg(bytes) };
}
