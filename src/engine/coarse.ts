// coarse.ts — EXPERIMENTAL resize-robust embedding (roadmap: beat downscaling).
//
// Status: prototype. Not wired into the UI — it exists so the resize-robustness
// harness (tools/resize-robustness/) can measure whether this actually survives
// a real downscale before we commit to it.
//
// Idea (see the discussion in the roadmap): block-DCT/QIM dies on resize for two
// reasons — the 8×8 grid desynchronises AND the downscale low-pass destroys the
// mid-frequency coefficient. Both are fixed by embedding in the *lowest* possible
// frequency: the MEAN luminance of a large tile. A tile's average survives
// downscaling almost perfectly (downscaling preserves local averages), and JPEG
// quantises the DC term least. QIM-modulating the tile mean therefore rides out
// recompression + scaling.
//
// The tile grid is defined as FRACTIONS of the image dimensions, so uniform
// scaling keeps every tile over the same content — the scheme is resync-free for
// pure scale (the messenger case). Cropping/padding would shift content vs the
// fractional grid; handling that needs an added sync marker + offset search and
// is out of scope for this prototype. DOM-free (needs only the ImageData shape).

export interface CoarseOpts {
  /** Tile grid as [cols, rows]. More tiles = more capacity, less robustness. */
  tiles?: [number, number];
  /** QIM step on the tile-mean luminance. Larger = more robust, more visible. */
  step?: number;
}
const DEFAULTS = { tiles: [24, 24] as [number, number], step: 8 };

const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** How many bits fit — one per tile. */
export function coarseCapacity(opts: CoarseOpts = {}): number {
  const [cols, rows] = opts.tiles ?? DEFAULTS.tiles;
  return cols * rows;
}

function qimEmbed(value: number, bit: number, step: number): number {
  let q = Math.round(value / step);
  if ((q & 1) !== bit) q += 1;
  return q * step;
}
function qimExtract(value: number, step: number): number {
  return Math.round(value / step) & 1;
}

/** Fractional tile bounds for tile (gx,gy) over a W×H image. */
function tileBounds(gx: number, gy: number, cols: number, rows: number, W: number, H: number) {
  return {
    x0: Math.floor((gx * W) / cols),
    x1: Math.floor(((gx + 1) * W) / cols),
    y0: Math.floor((gy * H) / rows),
    y1: Math.floor(((gy + 1) * H) / rows),
  };
}

/**
 * Embed `bits` (one per tile, row-major) into a copy of `image` by QIM-nudging
 * each tile's mean luminance. Colour (Cb/Cr) is preserved; only Y is shifted by
 * a per-tile DC offset, which is what survives downscaling.
 */
export function embedCoarse(image: ImageData, bits: ArrayLike<number>, opts: CoarseOpts = {}): ImageData {
  const [cols, rows] = opts.tiles ?? DEFAULTS.tiles;
  const step = opts.step ?? DEFAULTS.step;
  const cap = cols * rows;
  if (bits.length > cap) throw new Error(`too many bits: ${bits.length} > capacity ${cap}`);

  const W = image.width, H = image.height;
  const d = image.data;
  const n = W * H;

  // Y plane + preserved chroma.
  const Y = new Float64Array(n);
  const Cb = new Float64Array(n);
  const Cr = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  for (let bi = 0; bi < bits.length; bi++) {
    const gx = bi % cols, gy = Math.floor(bi / cols);
    const { x0, x1, y0, y1 } = tileBounds(gx, gy, cols, rows, W, H);
    let sum = 0, cnt = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) { sum += Y[y * W + x]; cnt++; }
    if (cnt === 0) continue;
    const mean = sum / cnt;
    const delta = qimEmbed(mean, bits[bi] & 1, step) - mean;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) { const j = y * W + x; Y[j] = clamp8(Y[j] + delta); }
  }

  const out = new Uint8ClampedArray(d.length);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const yv = Y[i], cb = Cb[i] - 128, cr = Cr[i] - 128;
    out[p] = clamp8(yv + 1.402 * cr);
    out[p + 1] = clamp8(yv - 0.344136 * cb - 0.714136 * cr);
    out[p + 2] = clamp8(yv + 1.772 * cb);
    out[p + 3] = 255;
  }
  return makeImageData(out, W, H);
}

/**
 * Extract `count` bits from `image`. The tile grid is recomputed from the
 * received image's own dimensions, so a uniformly-scaled image reads correctly
 * with no resync search.
 */
export function extractCoarse(image: ImageData, count: number, opts: CoarseOpts = {}): Uint8Array {
  const [cols, rows] = opts.tiles ?? DEFAULTS.tiles;
  const step = opts.step ?? DEFAULTS.step;
  const W = image.width, H = image.height;
  const d = image.data;
  const out = new Uint8Array(count);

  for (let bi = 0; bi < count; bi++) {
    const gx = bi % cols, gy = Math.floor(bi / cols);
    const { x0, x1, y0, y1 } = tileBounds(gx, gy, cols, rows, W, H);
    let sum = 0, cnt = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const p = (y * W + x) * 4;
        sum += 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        cnt++;
      }
    out[bi] = cnt === 0 ? 0 : qimExtract(sum / cnt, step);
  }
  return out;
}

function makeImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData !== "undefined") return new ImageData(data, width, height);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}
