// scatter.ts — seed-based pseudo-random permutation of LSB bit-slots.
//
// Plain sequential LSB embedding fills channels front-to-back, leaving a sharp
// "used vs. untouched" boundary that classic steganalysis keys on. Scattering
// spreads the payload bits pseudo-randomly across the whole image, dissolving
// that boundary.
//
// The permutation is a small balanced Feistel network with cycle-walking, so it
// is a true bijection over [0, count) computed in O(1) per index with no large
// lookup table — it scales to multi-megapixel images. When keyed off a password
// it also hides *where* the payload lives, on top of the AES-GCM secrecy of
// *what* it says. DOM-free and deterministic across engines (integer ops only).

const ROUNDS = 4;

/** lowbias32 integer hash — strong avalanche, 32-bit safe (imul + shifts). */
function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x >>> 0;
}

/**
 * Derive four 32-bit round-key words from a password. With no password a fixed
 * public constant is used — the layout is still whitened, just not secret.
 */
export function deriveScatterKey(password?: string): Uint32Array {
  const src = password && password.length > 0 ? `pw:${password}` : "Steganograph::public-scatter::v2";
  const bytes = new TextEncoder().encode(src);
  const key = new Uint32Array(4);
  const seeds = [0x811c9dc5, 0x1000193b, 0xdeadbeef, 0xcafebabe];
  for (let w = 0; w < 4; w++) {
    let h = seeds[w] >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h = (h ^ bytes[i]) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0; // FNV-1a prime
    }
    key[w] = mix32((h ^ Math.imul(w + 1, 0x9e3779b1)) >>> 0);
  }
  return key;
}

/**
 * Build a bijective slot permutation over [0, count): index i → its scattered
 * slot. Returns identity for degenerate sizes.
 */
export function makeSlotMapper(count: number, key: Uint32Array): (i: number) => number {
  if (count <= 1) return (i) => i;

  const bits = Math.ceil(Math.log2(count));
  const halfBits = Math.ceil(bits / 2);
  const half = 2 ** halfBits; // size of each Feistel half (mask+1)
  const mask = half - 1;

  const rk = new Uint32Array(ROUNDS);
  for (let r = 0; r < ROUNDS; r++) {
    rk[r] = (key[r % key.length] ^ Math.imul(r + 1, 0x9e3779b1)) >>> 0;
  }

  function feistel(x: number): number {
    let l = x & mask;
    let r = Math.floor(x / half) & mask;
    for (let i = 0; i < ROUNDS; i++) {
      const f = mix32((r ^ rk[i]) >>> 0) & mask;
      const nl = r;
      const nr = (l ^ f) & mask;
      l = nl;
      r = nr;
    }
    return r * half + l;
  }

  return (i: number): number => {
    // Cycle-walk: the Feistel network is a bijection on [0, half*half); keep
    // applying it until the result lands back inside [0, count). This yields a
    // bijection on [0, count). Expected iterations < 4.
    let x = i;
    do {
      x = feistel(x);
    } while (x >= count);
    return x;
  };
}
