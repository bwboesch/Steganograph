// resilient.ts — the "Resize-robust (JPEG)" codec: a third embedding mode that
// survives what the robust mode can't — downscaling by a messenger.
//
// It wraps coarse.ts (tile-mean QIM) the way robust.ts wraps dct.ts: same
// MAGIC/version/flags/length framing + AES-GCM, plus interleaved repetition ECC.
// One bit rides the mean luminance of each tile in a FIXED fractional grid, so
// uniform scaling reads back with no resync. Measured (tools/resize-robustness/):
// a full 79-byte / 35-byte-encrypted payload comes back byte-exact through ×0.5
// downscale + JPEG on both a 512² and a 1024² cover.
//
// The price is a small, FIXED capacity (the grid is a constant, independent of
// image size) and uniform-scale-only robustness — heavy crop/rotate can still
// break it. Use a reasonably large carrier so each tile still averages many
// pixels after the downscale. DOM-free.

import { encrypt, decrypt } from "./crypto";
import { embedCoarse, extractCoarse, coarseCapacity } from "./coarse";

const MAGIC = new Uint8Array([0x53, 0x54, 0x47, 0x5a]); // "STGZ"
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 1 + 4;
const HEADER_BITS = HEADER_BYTES * 8; // 80

const FLAG_ENCRYPTED = 0b0000_0001;

// Chosen by measurement (tools/resize-robustness/FINDINGS.md): 48² tiles at
// Δ=16 gave 0 residual errors to ×0.5 on both a 512² and 1024² cover, the
// safest point that still leaves usable capacity.
const TILES: [number, number] = [48, 48];
const STEP = 16;
const R_HEADER = 5;
const R_PAYLOAD = 3;
const CAP = coarseCapacity({ tiles: TILES }); // 2304 tiles/bits
const HEADER_REGION = HEADER_BITS * R_HEADER; // 400 tiles

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
function repEncode(bits: ArrayLike<number>, R: number): Uint8Array {
  const n = bits.length;
  const out = new Uint8Array(n * R);
  for (let r = 0; r < R; r++) for (let i = 0; i < n; i++) out[r * n + i] = bits[i];
  return out;
}
function repDecode(bits: ArrayLike<number>, n: number, R: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let ones = 0;
    for (let r = 0; r < R; r++) ones += bits[r * n + i];
    out[i] = ones * 2 > R ? 1 : 0;
  }
  return out;
}

/** Message bytes that fit — a FIXED figure (the grid is constant). */
export function resilientMessageCapacityBytes(): number {
  const payloadBitsCap = Math.floor((CAP - HEADER_REGION) / R_PAYLOAD);
  return Math.max(0, Math.floor(payloadBitsCap / 8));
}

/**
 * Encode `message` into a copy of `image` using tile-mean QIM. With a `password`
 * the payload is AES-GCM encrypted. The result must be exported as JPEG (or
 * re-saved) and survives re-encoding *and* uniform downscaling — not crop/rotate.
 */
export async function encodeResilient(
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
  new DataView(header.buffer).setUint32(6, payload.length, false);

  const encHeader = repEncode(bytesToBits(header), R_HEADER);
  const encPayload = repEncode(bytesToBits(payload), R_PAYLOAD);
  const total = encHeader.length + encPayload.length;

  if (total > CAP) {
    throw new Error(
      `message too large for resize-robust mode (max ${resilientMessageCapacityBytes()} bytes ` +
        `plaintext, ~${Math.max(0, resilientMessageCapacityBytes() - 44)} bytes encrypted)`,
    );
  }

  const bits = new Uint8Array(total);
  bits.set(encHeader, 0);
  bits.set(encPayload, encHeader.length);
  return embedCoarse(image, bits, { tiles: TILES, step: STEP });
}

/**
 * Decode a resize-robust message from `image` (possibly downscaled). Supply
 * `password` if encrypted. Throws on a bad header, wrong/missing password, or a
 * declared length that can't fit the fixed grid.
 */
export async function decodeResilient(image: ImageData, password?: string): Promise<string> {
  const headerBits = repDecode(
    extractCoarse(image, HEADER_REGION, { tiles: TILES, step: STEP }),
    HEADER_BITS,
    R_HEADER,
  );
  const header = bitsToBytes(headerBits);

  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) {
      throw new Error("no resize-robust message found (bad magic — wrong mode, or the image was cropped/rotated)");
    }
  }
  if (header[4] !== VERSION) {
    throw new Error(`unsupported resize-robust version: ${header[4]}`);
  }

  const flags = header[5];
  const encrypted = !!(flags & FLAG_ENCRYPTED);
  const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(6, false);

  if (encrypted && (!password || password.length === 0)) {
    throw new Error("this message is encrypted — a password is required");
  }

  const payloadRegion = length * 8 * R_PAYLOAD;
  if (HEADER_REGION + payloadRegion > CAP) {
    throw new Error("declared length exceeds capacity — corrupt header, wrong mode, or the image was cropped");
  }

  const all = extractCoarse(image, HEADER_REGION + payloadRegion, { tiles: TILES, step: STEP });
  const payloadBits = repDecode(all.subarray(HEADER_REGION), length * 8, R_PAYLOAD);
  const payload = bitsToBytes(payloadBits);

  return encrypted ? decrypt(payload, password!) : dec.decode(payload);
}

export { FLAG_ENCRYPTED };
