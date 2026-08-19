// stego.ts — LSB steganography over ImageData.
//
// Payload bits go into the least-significant bit of the R, G and B channels;
// the alpha channel is never touched for data. DOM-free: it only needs the
// `ImageData` shape ({ data, width, height }), so it is headless-testable.
//
// Subtle correctness point: browsers store canvas pixels with premultiplied
// alpha, so any pixel with alpha < 255 can have its color LSBs silently
// rounded when the canvas is read back or re-encoded — which would corrupt the
// payload. We therefore force every pixel opaque (alpha = 255) while embedding.

/** Bytes that fit in an image: 3 usable channels (RGB) per pixel, 8 bits/byte. */
export function capacityBytes(image: ImageData): number {
  return Math.floor((image.width * image.height * 3) / 8);
}

/**
 * Embed `bytes` into a copy of `image` and return the new ImageData.
 * Throws if `bytes` exceeds the image capacity.
 */
export function embed(image: ImageData, bytes: Uint8Array): ImageData {
  if (bytes.length > capacityBytes(image)) {
    throw new Error(
      `payload too large: ${bytes.length} bytes > capacity ${capacityBytes(image)} bytes`,
    );
  }

  const data = new Uint8ClampedArray(image.data); // copy — never mutate the source
  let bitIndex = 0;
  const totalBits = bytes.length * 8;

  for (let i = 0; i < data.length && bitIndex < totalBits; i += 4) {
    for (let channel = 0; channel < 3 && bitIndex < totalBits; channel++) {
      const bit = (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
      const p = i + channel;
      data[p] = (data[p] & 0xfe) | bit;
      bitIndex++;
    }
    data[i + 3] = 255; // force opaque so alpha rounding can't flip color LSBs
  }

  // Opacity must hold for every pixel, including those past the payload.
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }

  return makeImageData(data, image.width, image.height);
}

/** Extract exactly `length` bytes of payload from `image`. */
export function extract(image: ImageData, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const totalBits = length * 8;
  const data = image.data;
  let bitIndex = 0;

  for (let i = 0; i < data.length && bitIndex < totalBits; i += 4) {
    for (let channel = 0; channel < 3 && bitIndex < totalBits; channel++) {
      const bit = data[i + channel] & 1;
      out[bitIndex >> 3] |= bit << (7 - (bitIndex & 7));
      bitIndex++;
    }
  }

  if (bitIndex < totalBits) {
    throw new Error("image too small to contain the requested payload");
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
