// Resize-robustness harness — measures whether coarse tile-mean QIM (coarse.ts)
// survives a REAL downscale, where block-DCT/QIM (dct.ts) fails. Run:
//   bun tools/resize-robustness/harness.mjs   (needs Python + PIL)
//
// The key channel is jpeg_downscale: it downscales + JPEGs and DELIVERS the
// image at the small size — exactly what a messenger recipient gets. coarse.ts
// recomputes its tile grid from the received dimensions, so uniform scaling
// needs no resync search.

import { embedCoarse, extractCoarse, coarseCapacity } from "../../src/engine/coarse";
import { embedBits, extractBits, blockCapacity } from "../../src/engine/dct";

const HERE = import.meta.dir;
const PY = `${HERE}/../dct-robustness/jpeg_channel.py`;
const TMP = "/tmp/claude-1000/-home-servax-Projects-Steganograph/dee9a7f0-3ae1-4d7c-a961-7851cc96bd93/scratchpad";

if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data; this.width = width; this.height = height; this.colorSpace = "srgb";
    }
  };
}

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function makeCover(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const rnd = mulberry32(1234);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const grad = 40 + 150 * (x / w);
      const wave = 30 * Math.sin(x / 22) * Math.cos(y / 30);
      const tex = (rnd() - 0.5) * 14;
      data[p] = grad + wave + tex;
      data[p + 1] = 60 + 120 * (y / h) + 0.5 * wave + tex;
      data[p + 2] = 90 + 60 * Math.sin((x + y) / 40) + tex;
      data[p + 3] = 255;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (Math.hypot(x - w * 0.7, y - h * 0.35) < h * 0.18) {
        data[p] = 230; data[p + 1] = 220; data[p + 2] = 180;
      }
      if (y > h * 0.8 && y < h * 0.86) { data[p] *= 0.4; data[p + 1] *= 0.4; data[p + 2] *= 0.4; }
    }
  return new ImageData(data, w, h);
}

function writeRaw(image, path) {
  const { width: w, height: h, data } = image;
  const buf = Buffer.alloc(8 + w * h * 3);
  buf.writeUInt32LE(w, 0); buf.writeUInt32LE(h, 4);
  for (let i = 0, o = 8; i < w * h; i++) { const p = i * 4; buf[o++] = data[p]; buf[o++] = data[p + 1]; buf[o++] = data[p + 2]; }
  require("fs").writeFileSync(path, buf);
}
function readRaw(path) {
  const buf = require("fs").readFileSync(path);
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, o = 8; i < w * h; i++) { const p = i * 4; data[p] = buf[o++]; data[p + 1] = buf[o++]; data[p + 2] = buf[o++]; data[p + 3] = 255; }
  return new ImageData(data, w, h);
}
function channel(cmd, image, quality, scale) {
  const inRaw = `${TMP}/rz_in.raw`, outRaw = `${TMP}/rz_out.raw`;
  writeRaw(image, inRaw);
  const args = ["python3", PY, cmd, inRaw, outRaw, String(quality)];
  if (scale !== undefined) args.push(String(scale));
  const r = Bun.spawnSync(args);
  if (r.exitCode !== 0) throw new Error(`${cmd} failed: ` + r.stderr.toString());
  return readRaw(outRaw);
}

function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  return bits;
}
function bitsToBytes(bits) {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) { let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b]; out[i] = v; }
  return out;
}
function repEncode(bits, R) {
  const n = bits.length, out = new Uint8Array(n * R);
  for (let r = 0; r < R; r++) for (let i = 0; i < n; i++) out[r * n + i] = bits[i];
  return out;
}
function repDecode(bits, n, R) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { let ones = 0; for (let r = 0; r < R; r++) ones += bits[r * n + i]; out[i] = ones * 2 > R ? 1 : 0; }
  return out;
}

// --- run --------------------------------------------------------------------
const W = 512, H = 512;
const cover = makeCover(W, H);
console.log(`cover ${W}×${H}\n`);

function coarseBER(tiles, step, ch) {
  const cap = coarseCapacity({ tiles });
  const rnd = mulberry32(7);
  const payload = new Uint8Array(cap);
  for (let i = 0; i < cap; i++) payload[i] = rnd() < 0.5 ? 0 : 1;
  const stego = embedCoarse(cover, payload, { tiles, step });
  const got = ch(stego);
  const rec = extractCoarse(got, cap, { tiles, step });
  let bad = 0;
  for (let i = 0; i < cap; i++) if (rec[i] !== payload[i]) bad++;
  return bad / cap;
}

const CHANNELS = {
  none: (img) => img,
  "jpeg85": (img) => channel("jpeg", img, 85),
  "dn0.9": (img) => channel("jpeg_downscale", img, 85, 0.9),
  "dn0.75": (img) => channel("jpeg_downscale", img, 85, 0.75),
  "dn0.5": (img) => channel("jpeg_downscale", img, 85, 0.5),
  "dn0.35": (img) => channel("jpeg_downscale", img, 85, 0.35),
};
const CHNAMES = Object.keys(CHANNELS);

console.log("=== COARSE tile-mean QIM — raw BER (real downscale, delivered small) ===");
console.log("tiles×step   " + CHNAMES.map((c) => c.padStart(8)).join(""));
for (const tiles of [[16, 16], [24, 24], [32, 32]]) {
  for (const step of [6, 8, 12]) {
    const row = CHNAMES.map((c) => {
      const e = coarseBER(tiles, step, CHANNELS[c]);
      return (e === 0 ? "0" : (e * 100).toFixed(1) + "%").padStart(8);
    });
    console.log(`${tiles[0]}²  Δ=${String(step).padEnd(2)} ` + row.join(""));
  }
}

console.log("\n=== BASELINE: block-DCT/QIM (dct.ts) under the SAME downscale ===");
console.log("It has no scale invariance — this is what we're trying to beat.");
{
  const cap = blockCapacity(cover);
  const rnd = mulberry32(9);
  const payload = new Uint8Array(cap);
  for (let i = 0; i < cap; i++) payload[i] = rnd() < 0.5 ? 0 : 1;
  const stego = embedBits(cover, payload, { step: 28 });
  console.log("channel     BER");
  for (const c of CHNAMES) {
    const got = CHANNELS[c](stego);
    // block-DCT reads at received dims; count only over the blocks that exist
    const n = Math.min(cap, blockCapacity(got));
    const rec = extractBits(got, n, { step: 28 });
    let bad = 0;
    for (let i = 0; i < n; i++) if (rec[i] !== payload[i]) bad++;
    console.log(`${c.padEnd(10)} ${((bad / n) * 100).toFixed(1)}%`);
  }
}

console.log("\n=== Message survival through a real ×0.5 downscale (coarse + ECC) ===");
{
  const tiles = [32, 32]; // 1024 tiles
  const step = 8;
  const cap = coarseCapacity({ tiles });
  const msg = new TextEncoder().encode("meet@dawn pier 🔑".slice(0, 16));
  const msgBits = bytesToBits(msg);
  console.log(`message = ${msg.length} bytes = ${msgBits.length} bits, capacity ${cap} tiles`);
  for (const R of [3, 7, 11]) {
    if (msgBits.length * R > cap) { console.log(`R=${R}: exceeds capacity`); continue; }
    const enc = repEncode(msgBits, R);
    const stego = embedCoarse(cover, enc, { tiles, step });
    for (const [name, ch] of [["dn0.5", CHANNELS["dn0.5"]], ["dn0.35", CHANNELS["dn0.35"]]]) {
      const got = ch(stego);
      const rec = extractCoarse(got, enc.length, { tiles, step });
      const dec = repDecode(rec, msgBits.length, R);
      const outBytes = bitsToBytes(dec);
      let byteErr = 0;
      for (let i = 0; i < msg.length; i++) if (outBytes[i] !== msg[i]) byteErr++;
      console.log(`R=${String(R).padEnd(2)} ${name} -> ${byteErr === 0 ? "✓ EXACT" : "✗"} (${byteErr} byte errors)`);
    }
  }
}
