// DCT robustness harness — measures how well DCT/QIM-embedded bits survive real
// JPEG recompression (via PIL). Run: bun tools/dct-robustness/harness.mjs
//
// It (1) sanity-checks that with no recompression the bit-error-rate is ~0,
// then (2) sweeps JPEG quality × QIM step to tabulate raw BER, and (3) measures
// whether a real 40-byte message survives with repetition-code ECC.

import { embedBits, extractBits, blockCapacity } from "../../src/engine/dct";

const HERE = import.meta.dir;
const PY = `${HERE}/jpeg_channel.py`;
const TMP = "/tmp/claude-1000/-home-servax-Projects-Steganograph/dee9a7f0-3ae1-4d7c-a961-7851cc96bd93/scratchpad";

// --- ImageData shim ---------------------------------------------------------
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
      this.colorSpace = "srgb";
    }
  };
}

const mulberry32 = (a) => () => {
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A photo-ish cover: smooth gradients + gentle texture + a couple of shapes. */
function makeCover(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const rnd = mulberry32(1234);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const grad = 40 + 150 * (x / w);
      const wave = 30 * Math.sin(x / 22) * Math.cos(y / 30);
      const tex = (rnd() - 0.5) * 14; // low-amplitude texture
      const r = grad + wave + tex;
      const g = 60 + 120 * (y / h) + 0.5 * wave + tex;
      const b = 90 + 60 * Math.sin((x + y) / 40) + tex;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  // a bright disc + a dark bar → real low-frequency structure
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (Math.hypot(x - w * 0.7, y - h * 0.35) < h * 0.18) {
        data[p] = 230; data[p + 1] = 220; data[p + 2] = 180;
      }
      if (y > h * 0.8 && y < h * 0.86) {
        data[p] *= 0.4; data[p + 1] *= 0.4; data[p + 2] *= 0.4;
      }
    }
  return new ImageData(data, w, h);
}

// --- raw <-> image + JPEG channel -------------------------------------------
function writeRaw(image, path) {
  const { width: w, height: h, data } = image;
  const buf = Buffer.alloc(8 + w * h * 3);
  buf.writeUInt32LE(w, 0);
  buf.writeUInt32LE(h, 4);
  for (let i = 0, o = 8; i < w * h; i++) {
    const p = i * 4;
    buf[o++] = data[p]; buf[o++] = data[p + 1]; buf[o++] = data[p + 2];
  }
  require("fs").writeFileSync(path, buf);
}
function readRaw(path) {
  const buf = require("fs").readFileSync(path);
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, o = 8; i < w * h; i++) {
    const p = i * 4;
    data[p] = buf[o++]; data[p + 1] = buf[o++]; data[p + 2] = buf[o++]; data[p + 3] = 255;
  }
  return new ImageData(data, w, h);
}
function jpegChannel(image, quality) {
  const inRaw = `${TMP}/dct_in.raw`, outRaw = `${TMP}/dct_out.raw`;
  writeRaw(image, inRaw);
  const r = Bun.spawnSync(["python3", PY, "jpeg", inRaw, outRaw, String(quality)]);
  if (r.exitCode !== 0) throw new Error("jpeg channel failed: " + r.stderr.toString());
  return readRaw(outRaw);
}
function jpegResizeChannel(image, quality, scale) {
  const inRaw = `${TMP}/dct_in.raw`, outRaw = `${TMP}/dct_out.raw`;
  writeRaw(image, inRaw);
  const r = Bun.spawnSync(["python3", PY, "jpeg_resize", inRaw, outRaw, String(quality), String(scale)]);
  if (r.exitCode !== 0) throw new Error("jpeg_resize channel failed: " + r.stderr.toString());
  return readRaw(outRaw);
}

// --- ECC: interleaved repetition + majority vote ----------------------------
function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++)
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  return bits;
}
function bitsToBytes(bits) {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    out[i] = v;
  }
  return out;
}
function repEncode(bits, R) {
  const n = bits.length;
  const out = new Uint8Array(n * R);
  for (let r = 0; r < R; r++) for (let i = 0; i < n; i++) out[r * n + i] = bits[i]; // interleaved
  return out;
}
function repDecode(bits, n, R) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let ones = 0;
    for (let r = 0; r < R; r++) ones += bits[r * n + i];
    out[i] = ones * 2 > R ? 1 : 0;
  }
  return out;
}

// --- run --------------------------------------------------------------------
const W = 512, H = 512;
const cover = makeCover(W, H);
const CAP = blockCapacity(cover);
console.log(`cover ${W}×${H} → ${CAP} blocks (bits) capacity\n`);

const rnd = mulberry32(99);
const payload = new Uint8Array(CAP);
for (let i = 0; i < CAP; i++) payload[i] = rnd() < 0.5 ? 0 : 1;

const STEPS = [12, 20, 28, 40];
const QUALITIES = ["none", 95, 90, 85, 80, 75, 70, 60];

function ber(step, quality) {
  const stego = embedBits(cover, payload, { step });
  const channel = quality === "none" ? stego : jpegChannel(stego, quality);
  const rec = extractBits(channel, CAP, { step });
  let bad = 0;
  for (let i = 0; i < CAP; i++) if (rec[i] !== payload[i]) bad++;
  return bad / CAP;
}

console.log("=== Raw bit-error-rate (full capacity, 1 bit/block) ===");
console.log("step\\Q   " + QUALITIES.map((q) => String(q).padStart(7)).join(""));
for (const step of STEPS) {
  const row = QUALITIES.map((q) => {
    const e = ber(step, q);
    return (e === 0 ? "0" : (e * 100).toFixed(1) + "%").padStart(7);
  });
  console.log(`Δ=${String(step).padEnd(3)}  ` + row.join(""));
}

console.log("\n=== Raw BER WITH DOWNSCALE (the realistic messenger case) ===");
console.log("Downscale → JPEG(Q) → upscale back. This shifts the 8×8 block grid.");
const SCALES = [0.9, 0.75, 0.5];
console.log("step\\scale " + SCALES.map((s) => `x${s}`.padStart(9)).join(""));
for (const step of [28, 40]) {
  const stego = embedBits(cover, payload, { step });
  const row = SCALES.map((s) => {
    const channel = jpegResizeChannel(stego, 85, s);
    const rec = extractBits(channel, CAP, { step });
    let bad = 0;
    for (let i = 0; i < CAP; i++) if (rec[i] !== payload[i]) bad++;
    return ((bad / CAP) * 100).toFixed(1) + "%";
  }).map((s) => s.padStart(9));
  console.log(`Δ=${String(step).padEnd(3)}     ` + row.join(""));
}

console.log("\n=== 40-byte message survival (interleaved repetition ECC) ===");
const msg = new TextEncoder().encode("rendezvous 21:00 pier — bring the key!!!".slice(0, 40));
const msgBits = bytesToBits(msg); // 320 bits
console.log(`message = ${msg.length} bytes = ${msgBits.length} bits`);
console.log("config                      -> result (byte errors)");
for (const step of [20, 28, 40]) {
  for (const R of [1, 5, 11]) {
    if (msgBits.length * R > CAP) { console.log(`Δ=${step} R=${R}: exceeds capacity`); continue; }
    for (const q of [90, 80, 75, 70]) {
      const enc = repEncode(msgBits, R);
      const stego = embedBits(cover, enc, { step });
      const channel = q === "none" ? stego : jpegChannel(stego, q);
      const rec = extractBits(channel, enc.length, { step });
      const dec = repDecode(rec, msgBits.length, R);
      const outBytes = bitsToBytes(dec);
      let byteErr = 0;
      for (let i = 0; i < msg.length; i++) if (outBytes[i] !== msg[i]) byteErr++;
      const ok = byteErr === 0 ? "✓ EXACT" : "✗";
      console.log(`Δ=${String(step).padEnd(2)} R=${String(R).padEnd(2)} Q=${String(q).padEnd(3)} -> ${ok.padEnd(8)} (${byteErr})`);
    }
  }
}
