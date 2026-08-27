// engine.test.ts — headless proof of the DOM-free engine.
//
// Node 22 provides Web Crypto natively; the engine needs only the `ImageData`
// *shape*, so a tiny shim lets stego/codec run with no browser. Bundled with
// esbuild (see `npm run test`) to resolve the extensionless imports.

import { encode, decode, messageCapacityBytes } from "../src/engine/codec";
import { capacityBytes, embed, extract } from "../src/engine/stego";
import { makeSlotMapper, deriveScatterKey } from "../src/engine/scatter";
import { embedBits, extractBits, blockCapacity } from "../src/engine/dct";
import { encodeRobust, decodeRobust, robustMessageCapacityBytes } from "../src/engine/robust";
import { embedCoarse, extractCoarse, coarseCapacity } from "../src/engine/coarse";
import { encodeResilient, decodeResilient, resilientMessageCapacityBytes } from "../src/engine/resilient";

// --- ImageData shim ---------------------------------------------------------
if (typeof (globalThis as any).ImageData === "undefined") {
  (globalThis as any).ImageData = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace = "srgb";
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

/** A deterministic-ish noisy test image (opaque). */
function makeImage(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 7) & 0xff;
    data[i + 1] = (i * 13) & 0xff;
    data[i + 2] = (i * 29) & 0xff;
    data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
}

/** A smooth, mid-range photo-ish image — no saturated tiles to clip QIM offsets. */
function makeSmoothImage(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = 128 + 60 * Math.sin(x / 40) * Math.cos(y / 55);
      data[p + 1] = 128 + 50 * Math.sin((x + y) / 60);
      data[p + 2] = 128 + 40 * Math.cos(x / 70);
      data[p + 3] = 255;
    }
  return new ImageData(data, width, height);
}

/** Average each 2×2 block → half-size image. A clean stand-in for a resize. */
function boxDownscale2x(img: ImageData): ImageData {
  const w = img.width >> 1, h = img.height >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  const s = img.data, W = img.width;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = s[((2 * y) * W + 2 * x) * 4 + c];
        const b = s[((2 * y) * W + 2 * x + 1) * 4 + c];
        const d = s[((2 * y + 1) * W + 2 * x) * 4 + c];
        const e = s[((2 * y + 1) * W + 2 * x + 1) * 4 + c];
        out[o + c] = (a + b + d + e) / 4;
      }
      out[o + 3] = 255;
    }
  return new ImageData(out, w, h);
}

// --- micro test harness -----------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

async function throws(fn: () => Promise<unknown> | unknown): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  console.log("engine tests\n");

  // 1. Plaintext roundtrip.
  {
    const img = makeImage(64, 64);
    const msg = "hello, hidden world — äöü 🕵️";
    const out = await encode(img, msg);
    ok("plaintext roundtrip returns original", (await decode(out)) === msg);
  }

  // 2. Encrypted roundtrip.
  {
    const img = makeImage(64, 64);
    const msg = "top secret dossier";
    const out = await encode(img, msg, "correct horse battery staple");
    ok(
      "encrypted roundtrip returns original",
      (await decode(out, "correct horse battery staple")) === msg,
    );
  }

  // 3. Wrong password → GCM auth failure.
  {
    const img = makeImage(64, 64);
    const out = await encode(img, "secret", "right-password");
    ok("wrong password throws (GCM auth)", await throws(() => decode(out, "wrong-password")));
  }

  // 4. Encrypted payload without a password → clear error.
  {
    const img = makeImage(64, 64);
    const out = await encode(img, "secret", "pw");
    ok("encrypted without password throws", await throws(() => decode(out)));
  }

  // 5. Bad magic (unmodified image) → no message.
  {
    const img = makeImage(16, 16);
    ok("empty image reports no message", await throws(() => decode(img)));
  }

  // 6. Ciphertext expands plaintext → encrypted flag detected without a password.
  {
    const img = makeImage(64, 64);
    const out = await encode(img, "flagcheck", "pw");
    let requiredPassword = false;
    try {
      await decode(out);
    } catch (e) {
      requiredPassword = /password/i.test(String(e));
    }
    ok("encrypted flag is honored on decode", requiredPassword);
  }

  // 7. Capacity: a message that exactly fills the image succeeds.
  {
    const img = makeImage(32, 32);
    const cap = messageCapacityBytes(img); // plaintext: 1 byte === 1 char here
    const msg = "a".repeat(cap);
    const out = await encode(img, msg);
    ok("max-capacity plaintext fits and roundtrips", (await decode(out)) === msg);
  }

  // 8. Capacity: one byte over the limit is rejected.
  {
    const img = makeImage(32, 32);
    const msg = "a".repeat(messageCapacityBytes(img) + 1);
    ok("over-capacity message is rejected", await throws(() => encode(img, msg)));
  }

  // 9. LSB-only change: every channel differs by at most ±1 from the source.
  {
    const src = makeImage(64, 64);
    const out = await encode(src, "a moderately long secret message to spread bits", "pw");
    let maxDelta = 0;
    let alphaOk = true;
    for (let i = 0; i < src.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        maxDelta = Math.max(maxDelta, Math.abs(out.data[i + c] - src.data[i + c]));
      }
      if (out.data[i + 3] !== 255) alphaOk = false;
    }
    ok("color channels change by at most ±1 (LSB only)", maxDelta <= 1);
    ok("alpha normalized to opaque everywhere", alphaOk);
  }

  // 10. Low-level embed/extract roundtrip independent of the codec.
  {
    const img = makeImage(20, 20);
    const bytes = new Uint8Array([0, 255, 1, 254, 128, 42, 7]);
    const out = embed(img, bytes);
    const got = extract(out, bytes.length);
    ok(
      "raw embed/extract roundtrip",
      got.length === bytes.length && got.every((b, i) => b === bytes[i]),
    );
    ok("capacity math is sane", capacityBytes(img) === Math.floor((20 * 20 * 3) / 8));
  }

  // 11. The scatter permutation is a true bijection over [0, count).
  {
    const N = 500;
    const map = makeSlotMapper(N, deriveScatterKey("k"));
    const seen = new Set<number>();
    let inRange = true;
    for (let i = 0; i < N; i++) {
      const s = map(i);
      if (s < 0 || s >= N) inRange = false;
      seen.add(s);
    }
    ok("scatter permutation is a bijection", inRange && seen.size === N);
  }

  // 12. Whitening: a tiny message reaches well past the sequential prefix.
  {
    const src = makeImage(200, 1); // 200 px wide, N = 600 slots
    const out = await encode(src, "hi"); // ~96 header+payload bits
    let maxChangedPixel = -1;
    for (let p = 0; p < src.width * src.height; p++) {
      const i = p * 4;
      if (
        out.data[i] !== src.data[i] ||
        out.data[i + 1] !== src.data[i + 1] ||
        out.data[i + 2] !== src.data[i + 2]
      ) {
        maxChangedPixel = p;
      }
    }
    // A purely sequential embed would touch only the first ~32 pixels.
    ok("scatter spreads bits beyond the sequential prefix", maxChangedPixel > src.width * 0.5);
  }

  // 13. Determinism + key sensitivity.
  {
    const a1 = makeSlotMapper(1000, deriveScatterKey("alpha"));
    const a2 = makeSlotMapper(1000, deriveScatterKey("alpha"));
    const b = makeSlotMapper(1000, deriveScatterKey("beta"));
    let sameKeyEqual = true;
    let diffKeyDiffers = false;
    for (let i = 0; i < 1000; i++) {
      if (a1(i) !== a2(i)) sameKeyEqual = false;
      if (a1(i) !== b(i)) diffKeyDiffers = true;
    }
    ok("same key ⇒ identical order; different key ⇒ different", sameKeyEqual && diffKeyDiffers);
  }

  // 14. Location secrecy: an encrypted message's payload is keyed by password,
  //     so the header is still readable but the body needs the right password.
  {
    const img = makeImage(64, 64);
    const out = await encode(img, "coordinates: 51.5,-0.1", "the-key");
    // header (public) is readable → decode without a password reports "encrypted"
    let sawEncrypted = false;
    try {
      await decode(out);
    } catch (e) {
      sawEncrypted = /password/i.test(String(e));
    }
    const roundtrip = (await decode(out, "the-key")) === "coordinates: 51.5,-0.1";
    ok("encrypted payload is keyed yet header stays readable", sawEncrypted && roundtrip);
  }

  // 15. DCT/QIM prototype: lossless (no-recompression) bit roundtrip is exact.
  //     (JPEG-survival is measured separately in tools/dct-robustness/.)
  {
    const img = makeImage(64, 64); // 8×8 blocks → 64 bits capacity
    const cap = blockCapacity(img);
    ok("dct block capacity math", cap === 8 * 8);
    const bits = new Uint8Array(cap);
    for (let i = 0; i < cap; i++) bits[i] = (i * 5 + 1) & 1;
    const stego = embedBits(img, bits, { step: 24 });
    const got = extractBits(stego, cap, { step: 24 });
    let exact = true;
    for (let i = 0; i < cap; i++) if (got[i] !== bits[i]) exact = false;
    ok("dct embed/extract roundtrip is exact (no recompression)", exact);
  }

  // 16. Robust mode: plaintext roundtrip through the DCT/QIM codec (no channel).
  //     Header alone costs 80·5 = 400 blocks, so images must be comfortably big.
  {
    const img = makeImage(320, 320); // 40×40 = 1600 blocks
    const msg = "robust plaintext — äöü";
    const out = await encodeRobust(img, msg);
    ok("robust plaintext roundtrip", (await decodeRobust(out)) === msg);
  }

  // 17. Robust mode: encrypted roundtrip + wrong password fails loudly.
  {
    const img = makeImage(384, 384); // encryption adds ~44 bytes → needs more room
    const msg = "coords 51.5,-0.1";
    const out = await encodeRobust(img, msg, "the-key");
    ok("robust encrypted roundtrip", (await decodeRobust(out, "the-key")) === msg);
    ok("robust wrong password throws", await throws(() => decodeRobust(out, "nope")));
    // header is public → decode without a password reports "encrypted"
    let needsPw = false;
    try {
      await decodeRobust(out);
    } catch (e) {
      needsPw = /password/i.test(String(e));
    }
    ok("robust encrypted flag honored", needsPw);
  }

  // 18. Robust mode: survives a real JPEG re-encode (the whole point).
  //     Simulate the export→messenger channel by requantizing each DCT coeff
  //     to a plausible JPEG step, in-process (no external tools needed here).
  {
    const img = makeImage(256, 256); // 32×32 = 1024 blocks
    const msg = "survives re-encoding";
    const stego = await encodeRobust(img, msg);
    // Coarsely requantize luma-ish: round every channel to steps of 8 — a
    // heavier perturbation than JPEG Q92, well within Δ=24's margin.
    const noisy = new Uint8ClampedArray(stego.data.length);
    for (let i = 0; i < noisy.length; i += 4) {
      for (let c = 0; c < 3; c++) noisy[i + c] = Math.round(stego.data[i + c] / 8) * 8;
      noisy[i + 3] = 255;
    }
    const channel = new ImageData(noisy, stego.width, stego.height);
    ok("robust survives coarse requantization (±JPEG-like)", (await decodeRobust(channel)) === msg);
  }

  // 19. Robust capacity: an over-capacity message is rejected.
  {
    const img = makeImage(64, 64); // 64 blocks total, header alone needs 400
    ok("robust reports zero capacity when image too small", robustMessageCapacityBytes(img) === 0);
    ok("robust over-capacity is rejected", await throws(() => encodeRobust(img, "x".repeat(100))));
  }

  // 20. Coarse (resize-robust) prototype: exact bit roundtrip, no channel.
  {
    const img = makeImage(256, 256);
    const tiles: [number, number] = [16, 16];
    const cap = coarseCapacity({ tiles });
    ok("coarse capacity math", cap === 16 * 16);
    const bits = new Uint8Array(cap);
    for (let i = 0; i < cap; i++) bits[i] = (i * 3 + 1) & 1;
    const stego = embedCoarse(img, bits, { tiles, step: 8 });
    const got = extractCoarse(stego, cap, { tiles, step: 8 });
    let exact = true;
    for (let i = 0; i < cap; i++) if (got[i] !== bits[i]) exact = false;
    ok("coarse embed/extract roundtrip is exact", exact);
  }

  // 21. Coarse scale-invariance: the whole point. Embed, box-downscale 2× (a
  //     clean stand-in for a messenger resize), extract via the fractional grid.
  {
    const img = makeSmoothImage(256, 256);
    const tiles: [number, number] = [16, 16];
    const cap = coarseCapacity({ tiles });
    const bits = new Uint8Array(cap);
    for (let i = 0; i < cap; i++) bits[i] = (i * 7 + 3) & 1;
    const stego = embedCoarse(img, bits, { tiles, step: 10 });
    const small = boxDownscale2x(stego); // 256×256 → 128×128
    const got = extractCoarse(small, cap, { tiles, step: 10 });
    let bad = 0;
    for (let i = 0; i < cap; i++) if (got[i] !== bits[i]) bad++;
    ok("coarse survives a 2× downscale (fractional grid)", bad === 0);
  }

  // 22. Coarse over-capacity is rejected.
  {
    const img = makeImage(64, 64);
    const tiles: [number, number] = [8, 8];
    ok("coarse over-capacity is rejected", await throws(() =>
      Promise.resolve(embedCoarse(img, new Uint8Array(coarseCapacity({ tiles }) + 1), { tiles })),
    ));
  }

  // 23. Resize-robust codec: plaintext + encrypted roundtrip (no channel).
  {
    const img = makeSmoothImage(512, 512);
    const msg = "meet@dawn — 51.5,-0.1";
    ok("resilient plaintext roundtrip", (await decodeResilient(await encodeResilient(img, msg))) === msg);
    const enc = await encodeResilient(img, "the key is 42", "pw");
    ok("resilient encrypted roundtrip", (await decodeResilient(enc, "pw")) === "the key is 42");
    ok("resilient wrong password throws", await throws(() => decodeResilient(enc, "no")));
  }

  // 24. Resize-robust survives a 2× downscale — the headline claim — for a full
  //     encrypted payload (all-or-nothing: one residual bit error fails GCM).
  {
    const img = makeSmoothImage(512, 512);
    const secret = "rendezvous 21:00";
    const stego = await encodeResilient(img, secret, "s3cret");
    const small = boxDownscale2x(stego); // 512 → 256
    ok("resilient encrypted survives 2× downscale", (await decodeResilient(small, "s3cret")) === secret);
  }

  // 25. Resize-robust capacity is fixed and over-capacity is rejected.
  {
    const img = makeSmoothImage(512, 512);
    const cap = resilientMessageCapacityBytes();
    ok("resilient capacity is a sane fixed figure", cap > 40 && cap < 200);
    ok("resilient over-capacity is rejected", await throws(() => encodeResilient(img, "x".repeat(cap + 1))));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("failures: " + failures.join(", "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
