// engine.test.ts — headless proof of the DOM-free engine.
//
// Node 22 provides Web Crypto natively; the engine needs only the `ImageData`
// *shape*, so a tiny shim lets stego/codec run with no browser. Bundled with
// esbuild (see `npm run test`) to resolve the extensionless imports.

import { encode, decode, messageCapacityBytes } from "../src/engine/codec";
import { capacityBytes, embed, extract } from "../src/engine/stego";

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
