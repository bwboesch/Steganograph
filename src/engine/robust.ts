// robust.ts — the "Robust (JPEG)" codec: a second embedding mode that survives
// JPEG re-encoding (email, Telegram-as-file, Signal original, cloud links).
//
// Unlike the lossless LSB codec (codec.ts), this hides data in the DCT domain
// via QIM (dct.ts): one bit per 8×8 luminance block, at a step Δ large enough to
// ride out quantization. Because JPEG *is* block-DCT quantization, the payload
// comes back after recompression. The trade-off, measured in
// tools/dct-robustness/FINDINGS.md: it does **NOT** survive resizing — anything
// that downscales (WhatsApp/Instagram) shifts the 8×8 grid and wipes it.
//
// Frame layout (bits, before repetition coding):
//   MAGIC(4) ‖ version(1) ‖ flags(1) ‖ length(4, uint32 BE) ‖ payload(length)
// The 10-byte header is protected with a heavier repetition code than the body
// (a header bit-flip is catastrophic), so decode() can recover the length before
// it knows how big the payload is. Each region is interleaved independently, so
// a localised burst of block errors is spread across all repetitions.

import { encrypt, decrypt } from "./crypto";
import { embedBits, extractBits, blockCapacity } from "./dct";

const MAGIC = new Uint8Array([0x53, 0x54, 0x47, 0x52]); // "STGR"
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 1 + 4;
const HEADER_BITS = HEADER_BYTES * 8; // 80

const FLAG_ENCRYPTED = 0b0000_0001;

// Robustness knobs (see FINDINGS.md: Δ=24 gives 0 errors to JPEG Q60).
const STEP = 24;
const R_HEADER = 5; // header: small + critical → extra redundancy
const R_PAYLOAD = 3; // body: light interleaved repetition for margin
const HEADER_REGION = HEADER_BITS * R_HEADER; // blocks consumed by the header

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- bit <-> byte (MSB first) ----------------------------------------------
function bytesToBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++)
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  return bits;
}
function bitsToBytes(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    out[i] = v;
  }
  return out;
}

// --- interleaved repetition code -------------------------------------------
/** R interleaved copies: [b0..bN][b0..bN]… so repeats are spread out. */
function repEncode(bits: ArrayLike<number>, R: number): Uint8Array {
  const n = bits.length;
  const out = new Uint8Array(n * R);
  for (let r = 0; r < R; r++) for (let i = 0; i < n; i++) out[r * n + i] = bits[i];
  return out;
}
/** Majority vote over the R interleaved copies. */
function repDecode(bits: ArrayLike<number>, n: number, R: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let ones = 0;
    for (let r = 0; r < R; r++) ones += bits[r * n + i];
    out[i] = ones * 2 > R ? 1 : 0;
  }
  return out;
}

/** How many message bytes fit in this image in robust mode (after ECC + header). */
export function robustMessageCapacityBytes(image: ImageData): number {
  const cap = blockCapacity(image);
  const payloadBitsCap = Math.floor((cap - HEADER_REGION) / R_PAYLOAD);
  return Math.max(0, Math.floor(payloadBitsCap / 8));
}

/**
 * Encode `message` into a copy of `image` using DCT/QIM. With a `password` the
 * payload is AES-GCM encrypted and the encrypted flag is set. The result must be
 * exported as JPEG (quality ≥ ~0.6) or re-saved without resizing to survive.
 */
export async function encodeRobust(
  image: ImageData,
  message: string,
  password?: string,
): Promise<ImageData> {
  const encrypted = !!(password && password.length > 0);
  const payload = encrypted ? await encrypt(message, password!) : enc.encode(message);
  const flags = encrypted ? FLAG_ENCRYPTED : 0;

  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[5] = flags;
  new DataView(header.buffer).setUint32(6, payload.length, false); // big-endian

  const encHeader = repEncode(bytesToBits(header), R_HEADER);
  const encPayload = repEncode(bytesToBits(payload), R_PAYLOAD);
  const total = encHeader.length + encPayload.length;

  const cap = blockCapacity(image);
  if (total > cap) {
    throw new Error(
      `message too large for robust mode (need ${total} blocks, capacity ${cap}; ` +
        `max ~${robustMessageCapacityBytes(image)} bytes for this image)`,
    );
  }

  const bits = new Uint8Array(total);
  bits.set(encHeader, 0);
  bits.set(encPayload, encHeader.length);
  return embedBits(image, bits, { step: STEP });
}

/**
 * Decode a robust-mode message from `image`. Supply `password` if encrypted.
 * Throws on a bad header (not a robust stego image, or it was resized), a
 * wrong/missing password, or a declared length that can't fit the image.
 */
export async function decodeRobust(image: ImageData, password?: string): Promise<string> {
  const cap = blockCapacity(image);
  if (cap < HEADER_REGION) {
    throw new Error("image too small to hold a robust-mode message");
  }

  const headerBits = repDecode(extractBits(image, HEADER_REGION, { step: STEP }), HEADER_BITS, R_HEADER);
  const header = bitsToBytes(headerBits);

  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) {
      throw new Error("no robust-mode message found (bad magic — wrong mode, or the image was resized)");
    }
  }
  if (header[4] !== VERSION) {
    throw new Error(`unsupported robust version: ${header[4]}`);
  }

  const flags = header[5];
  const encrypted = !!(flags & FLAG_ENCRYPTED);
  const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(6, false);

  if (encrypted && (!password || password.length === 0)) {
    throw new Error("this message is encrypted — a password is required");
  }

  const payloadRegion = length * 8 * R_PAYLOAD;
  if (HEADER_REGION + payloadRegion > cap) {
    throw new Error("declared length exceeds image capacity — corrupt header, wrong mode, or the image was resized");
  }

  const all = extractBits(image, HEADER_REGION + payloadRegion, { step: STEP });
  const payloadBits = repDecode(all.subarray(HEADER_REGION), length * 8, R_PAYLOAD);
  const payload = bitsToBytes(payloadBits);

  return encrypted ? decrypt(payload, password!) : dec.decode(payload);
}

export { FLAG_ENCRYPTED };
