// codec.ts — frames a message with a header and clamps crypto + stego together.
//
// On-image layout (before LSB embedding):
//   MAGIC(4) ‖ version(1) ‖ flags(1) ‖ length(4, uint32 BE) ‖ payload(length)
//
// Bit placement (scatter.ts): the header always rides a PUBLIC permutation, so
// decode() can read the length + flags — and tell the user "this is encrypted"
// — without any password. The payload rides a second permutation over the
// remaining slots; when the message is encrypted that permutation is keyed by
// the password, so an attacker cannot even locate the payload bits without it.

import { encrypt, decrypt } from "./crypto";
import { capacityBytes, embed, extract } from "./stego";
import { deriveScatterKey, makeSlotMapper } from "./scatter";

const MAGIC = new Uint8Array([0x53, 0x54, 0x47, 0x31]); // "STG1"
const VERSION = 2; // v2 = scattered layout
const HEADER_BYTES = 4 + 1 + 1 + 4;
const HEADER_BITS = HEADER_BYTES * 8;

const FLAG_ENCRYPTED = 0b0000_0001;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Total capacity for a message payload (image capacity minus the header). */
export function messageCapacityBytes(image: ImageData): number {
  return Math.max(0, capacityBytes(image) - HEADER_BYTES);
}

/**
 * Build the slot mapper for a whole frame: header bits ride the public
 * permutation `pub(0..HEADER_BITS)`, payload bits ride the (possibly keyed)
 * permutation over the remaining slots, `pub(HEADER_BITS + q(j))`. Because the
 * payload is offset past the header region, the two never collide.
 */
function frameMapper(image: ImageData, encrypted: boolean, password?: string): (k: number) => number {
  const totalSlots = image.width * image.height * 3;
  const payloadSlots = totalSlots - HEADER_BITS;
  const pub = makeSlotMapper(totalSlots, deriveScatterKey());
  const payKey = encrypted ? deriveScatterKey(password) : deriveScatterKey();
  const q = makeSlotMapper(Math.max(1, payloadSlots), payKey);
  return (k: number): number =>
    k < HEADER_BITS ? pub(k) : pub(HEADER_BITS + q(k - HEADER_BITS));
}

/**
 * Encode `message` into a copy of `image`. When `password` is given the message
 * is AES-GCM encrypted and the encrypted flag is set. Throws if it won't fit.
 */
export async function encode(
  image: ImageData,
  message: string,
  password?: string,
): Promise<ImageData> {
  const encrypted = !!(password && password.length > 0);
  const payload = encrypted ? await encrypt(message, password!) : enc.encode(message);
  const flags = encrypted ? FLAG_ENCRYPTED : 0;

  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  frame.set(MAGIC, 0);
  frame[4] = VERSION;
  frame[5] = flags;
  new DataView(frame.buffer).setUint32(6, payload.length, false); // big-endian
  frame.set(payload, HEADER_BYTES);

  if (frame.length > capacityBytes(image)) {
    throw new Error(
      `message too large for this image (need ${frame.length} bytes, capacity ${capacityBytes(image)})`,
    );
  }

  return embed(image, frame, frameMapper(image, encrypted, password));
}

/**
 * Decode a message from `image`. Supply `password` if the payload is encrypted.
 * Throws on a bad header, a wrong/missing password, or truncated data.
 */
export async function decode(image: ImageData, password?: string): Promise<string> {
  // Header rides the public permutation — readable without a password.
  const headerMap = frameMapper(image, false); // only the header region is touched here
  const header = extract(image, HEADER_BYTES, headerMap);

  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) {
      throw new Error("no hidden message found (bad magic)");
    }
  }
  if (header[4] !== VERSION) {
    throw new Error(`unsupported version: ${header[4]}`);
  }

  const flags = header[5];
  const encrypted = !!(flags & FLAG_ENCRYPTED);
  const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(6, false);

  if (encrypted && (!password || password.length === 0)) {
    throw new Error("this message is encrypted — a password is required");
  }

  const full = extract(image, HEADER_BYTES + length, frameMapper(image, encrypted, password));
  const payload = full.subarray(HEADER_BYTES);

  return encrypted ? decrypt(payload, password!) : dec.decode(payload);
}

export { FLAG_ENCRYPTED };
