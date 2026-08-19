// codec.ts — frames a message with a header and clamps crypto + stego together.
//
// On-image layout (before LSB embedding):
//   MAGIC(4) ‖ version(1) ‖ flags(1) ‖ length(4, uint32 BE) ‖ payload(length)
// The header is always plaintext so decode() can learn the payload length and
// whether it is encrypted before touching the body.

import { encrypt, decrypt } from "./crypto";
import { capacityBytes, embed, extract } from "./stego";

const MAGIC = new Uint8Array([0x53, 0x54, 0x47, 0x31]); // "STG1"
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 1 + 4;

const FLAG_ENCRYPTED = 0b0000_0001;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Total capacity for a message payload (image capacity minus the header). */
export function messageCapacityBytes(image: ImageData): number {
  return Math.max(0, capacityBytes(image) - HEADER_BYTES);
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
  let payload: Uint8Array;
  let flags = 0;

  if (password && password.length > 0) {
    payload = await encrypt(message, password);
    flags |= FLAG_ENCRYPTED;
  } else {
    payload = enc.encode(message);
  }

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

  return embed(image, frame);
}

/**
 * Decode a message from `image`. Supply `password` if the payload is encrypted.
 * Throws on a bad header, a wrong/missing password, or truncated data.
 */
export async function decode(image: ImageData, password?: string): Promise<string> {
  const header = extract(image, HEADER_BYTES);

  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) {
      throw new Error("no hidden message found (bad magic)");
    }
  }
  if (header[4] !== VERSION) {
    throw new Error(`unsupported version: ${header[4]}`);
  }

  const flags = header[5];
  const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(6, false);

  const full = extract(image, HEADER_BYTES + length);
  const payload = full.subarray(HEADER_BYTES);

  if (flags & FLAG_ENCRYPTED) {
    if (!password || password.length === 0) {
      throw new Error("this message is encrypted — a password is required");
    }
    return decrypt(payload, password);
  }
  return dec.decode(payload);
}

export { FLAG_ENCRYPTED };
