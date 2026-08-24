// stego.ts — LSB steganography over ImageData.
//
// Payload bits go into the least-significant bit of the R, G and B channels;
// the alpha channel is never touched for data. DOM-free: it only needs the
// `ImageData` shape ({ data, width, height }), so it is headless-testable.
//
// Bits are addressed by *slot*: slot s → pixel ⌊s/3⌋, channel s%3 (0=R,1=G,2=B).
// An optional `mapSlot` reorders which slot each successive payload bit occupies
// — pass one from `scatter.ts` to spread bits pseudo-randomly across the image;
// omit it for the plain front-to-back order.
//
// Subtle correctness point: browsers store canvas pixels with premultiplied
// alpha, so any pixel with alpha < 255 can have its color LSBs silently rounded
// when the canvas is read back or re-encoded — which would corrupt the payload.
// We therefore force every pixel opaque (alpha = 255) while embedding.

/** Identity slot order: bit i → slot i (front-to-back R,G,B). */
const IDENTITY = (i: number): number => i;

/** Bytes that fit in an image: 3 usable channels (RGB) per pixel, 8 bits/byte. */
export function capacityBytes(image: ImageData): number {
  return Math.floor((image.width * image.height * 3) / 8);
}

/**
 * Embed `bytes` into a copy of `image` and return the new ImageData.
 * `mapSlot` maps each payload-bit index to a slot (default: sequential).
 * Throws if `bytes` exceeds the image capacity.
 */
export function embed(
  image: ImageData,
  bytes: Uint8Array,
  mapSlot: (i: number) => number = IDENTITY,
): ImageData {
  const totalSlots = image.width * image.height * 3;
  const totalBits = bytes.length * 8;
  if (totalBits > totalSlots) {
    throw new Error(
      `payload too large: ${bytes.length} bytes > capacity ${Math.floor(totalSlots / 8)} bytes`,
    );
  }

  const data = new Uint8ClampedArray(image.data); // copy — never mutate the source

  // Force every pixel opaque first, so alpha rounding can't flip color LSBs.
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }

  for (let k = 0; k < totalBits; k++) {
    const bit = (bytes[k >> 3] >> (7 - (k & 7))) & 1;
    const slot = mapSlot(k);
    const pixel = Math.floor(slot / 3);
    const p = pixel * 4 + (slot - pixel * 3);
    data[p] = (data[p] & 0xfe) | bit;
  }

  return makeImageData(data, image.width, image.height);
}

/**
 * Extract exactly `length` bytes of payload from `image`, using the same
 * `mapSlot` order that embedded it (default: sequential).
 */
export function extract(
  image: ImageData,
  length: number,
  mapSlot: (i: number) => number = IDENTITY,
): Uint8Array {
  const totalSlots = image.width * image.height * 3;
  const totalBits = length * 8;
  if (totalBits > totalSlots) {
    throw new Error("image too small to contain the requested payload");
  }

  const out = new Uint8Array(length);
  const data = image.data;
  for (let k = 0; k < totalBits; k++) {
    const slot = mapSlot(k);
    const pixel = Math.floor(slot / 3);
    const bit = data[pixel * 4 + (slot - pixel * 3)] & 1;
    out[k >> 3] |= bit << (7 - (k & 7));
  }
  return out;
}

/**
 * Construct an ImageData. Uses the real constructor in the browser and falls
 * back to a plain object in headless (Node) contexts where it is undefined.
 */
function makeImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData !== "undefined") {
    return new ImageData(data, width, height);
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
