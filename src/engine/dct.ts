// dct.ts — EXPERIMENTAL DCT-domain embedding (roadmap: recompression robustness).
//
// Status: prototype. Not wired into the UI yet — it exists so the robustness
// harness (tools/dct-robustness/) can measure how well data survives JPEG
// re-encoding before we commit to a shipped "robust mode".
//
// Approach: quantization-index modulation (QIM) on one mid-frequency DCT
// coefficient of each 8×8 luminance (Y) block. One bit per block. The step Δ is
// the robustness knob: as long as Δ is comfortably larger than the JPEG
// quantization step for that coefficient at the target quality, the bit
// survives the round-trip. Colour is preserved by modifying only Y and keeping
// the original Cb/Cr. DOM-free (needs only the ImageData shape).

const N = 8;

// Precomputed 8-point DCT-II basis (orthonormal): C[k][n].
const COS: number[][] = (() => {
  const t: number[][] = [];
  for (let k = 0; k < N; k++) {
    t[k] = [];
    const a = k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N);
    for (let n = 0; n < N; n++) {
      t[k][n] = a * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    }
  }
  return t;
})();

/** Forward 2D DCT-II of an 8×8 block (in place-safe: returns a new array). */
function fdct8x8(block: Float64Array): Float64Array {
  const tmp = new Float64Array(64);
  const out = new Float64Array(64);
  // rows
  for (let y = 0; y < N; y++) {
    for (let k = 0; k < N; k++) {
      let s = 0;
      for (let n = 0; n < N; n++) s += block[y * N + n] * COS[k][n];
      tmp[y * N + k] = s;
    }
  }
  // cols
  for (let x = 0; x < N; x++) {
    for (let k = 0; k < N; k++) {
      let s = 0;
      for (let n = 0; n < N; n++) s += tmp[n * N + x] * COS[k][n];
      out[k * N + x] = s;
    }
  }
  return out;
}

/** Inverse 2D DCT-II of an 8×8 coefficient block. */
function idct8x8(coeff: Float64Array): Float64Array {
  const tmp = new Float64Array(64);
  const out = new Float64Array(64);
  // cols
  for (let x = 0; x < N; x++) {
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let k = 0; k < N; k++) s += coeff[k * N + x] * COS[k][n];
      tmp[n * N + x] = s;
    }
  }
  // rows
  for (let y = 0; y < N; y++) {
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let k = 0; k < N; k++) s += tmp[y * N + k] * COS[k][n];
      out[y * N + n] = s;
    }
  }
  return out;
}

export interface DctOpts {
  /** QIM step size (robustness knob). Larger = more robust, more visible. */
  step?: number;
  /** Which DCT coefficient to modulate, as [u, v] (row, col). Mid-freq default. */
  coeff?: [number, number];
}
const DEFAULTS = { step: 24, coeff: [3, 2] as [number, number] };

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Extract Y, Cb, Cr float planes (BT.601) from an image. */
function toYCbCr(image: ImageData): { Y: Float64Array; Cb: Float64Array; Cr: Float64Array } {
  const n = image.width * image.height;
  const Y = new Float64Array(n);
  const Cb = new Float64Array(n);
  const Cr = new Float64Array(n);
  const d = image.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { Y, Cb, Cr };
}

/** Just the luminance plane (for extraction from a recompressed image). */
function toY(image: ImageData): Float64Array {
  const n = image.width * image.height;
  const Y = new Float64Array(n);
  const d = image.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    Y[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return Y;
}

/** Number of whole 8×8 blocks — i.e. how many bits fit (1 bit/block). */
export function blockCapacity(image: ImageData): number {
  return Math.floor(image.height / N) * Math.floor(image.width / N);
}

function qimEmbed(value: number, bit: number, step: number): number {
  let q = Math.round(value / step);
  if ((q & 1) !== bit) q += 1; // nudge to the nearest lattice point of the right parity
  return q * step;
}
function qimExtract(value: number, step: number): number {
  return Math.round(value / step) & 1;
}

/** Embed `bits` (one per 8×8 block, row-major) into a copy of `image`. */
export function embedBits(image: ImageData, bits: ArrayLike<number>, opts: DctOpts = {}): ImageData {
  const step = opts.step ?? DEFAULTS.step;
  const [cu, cv] = opts.coeff ?? DEFAULTS.coeff;
  const cap = blockCapacity(image);
  if (bits.length > cap) throw new Error(`too many bits: ${bits.length} > capacity ${cap}`);

  const { Y, Cb, Cr } = toYCbCr(image);
  const w = image.width;
  const bw = Math.floor(w / N);
  const bh = Math.floor(image.height / N);
  const block = new Float64Array(64);

  for (let bi = 0; bi < bits.length; bi++) {
    const by = Math.floor(bi / bw);
    const bx = bi % bw;
    if (by >= bh) break;
    const ox = bx * N, oy = by * N;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) block[y * N + x] = Y[(oy + y) * w + (ox + x)] - 128;
    const c = fdct8x8(block);
    c[cu * N + cv] = qimEmbed(c[cu * N + cv], bits[bi] & 1, step);
    const r = idct8x8(c);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) Y[(oy + y) * w + (ox + x)] = r[y * N + x] + 128;
  }

  // Rebuild RGBA from modified Y + original Cb/Cr.
  const out = new Uint8ClampedArray(image.data.length);
  const nPix = image.width * image.height;
  for (let i = 0, p = 0; i < nPix; i++, p += 4) {
    const yv = Y[i], cb = Cb[i] - 128, cr = Cr[i] - 128;
    out[p] = clamp8(yv + 1.402 * cr);
    out[p + 1] = clamp8(yv - 0.344136 * cb - 0.714136 * cr);
    out[p + 2] = clamp8(yv + 1.772 * cb);
    out[p + 3] = 255;
  }
  return makeImageData(out, image.width, image.height);
}

/** Extract `count` bits (one per 8×8 block, row-major) from `image`. */
export function extractBits(image: ImageData, count: number, opts: DctOpts = {}): Uint8Array {
  const step = opts.step ?? DEFAULTS.step;
  const [cu, cv] = opts.coeff ?? DEFAULTS.coeff;
  const Y = toY(image);
  const w = image.width;
  const bw = Math.floor(w / N);
  const bh = Math.floor(image.height / N);
  const out = new Uint8Array(count);
  const block = new Float64Array(64);

  for (let bi = 0; bi < count; bi++) {
    const by = Math.floor(bi / bw);
    const bx = bi % bw;
    if (by >= bh) break;
    const ox = bx * N, oy = by * N;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) block[y * N + x] = Y[(oy + y) * w + (ox + x)] - 128;
    const c = fdct8x8(block);
    out[bi] = qimExtract(c[cu * N + cv], step);
  }
  return out;
}

function makeImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData !== "undefined") return new ImageData(data, width, height);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
