# Resize robustness — measured findings

Goal: the DCT "Robust (JPEG)" mode survives re-encoding but **not** resizing
(see `../dct-robustness/FINDINGS.md`). This measures a prototype aimed squarely
at the resize case — the one that matters for messengers that downscale
(WhatsApp, Instagram, most chat apps).

Method: **coarse tile-mean QIM** (`src/engine/coarse.ts`). Embed one bit per
large tile by QIM-nudging that tile's **mean luminance**. Two properties make it
resize-robust:

1. The mean of a big region is the lowest possible frequency — downscaling (a
   low-pass filter) *preserves* it, and JPEG quantises the DC term least.
2. The tile grid is defined as **fractions of the image dimensions**, so uniform
   scaling keeps every tile over the same content. No resync search is needed
   for pure scale — the fractional grid *is* the resync.

Channel: `jpeg_downscale` in `../dct-robustness/jpeg_channel.py` downscales +
JPEGs and **delivers the image at the small size** — what a recipient actually
gets, unlike the earlier harness which upscaled back to the original size.

Cover: 512×512, gradients + texture + shapes.

## 1. Raw bit-error-rate (real downscale, delivered at small size)

| tiles | Δ | none | jpeg85 | ×0.9 | ×0.75 | ×0.5 | ×0.35 |
|-------|---|------|--------|------|-------|------|-------|
| 16² | 8 | 0 | 0 | 0 | 0 | 0 | 9.0% |
| 16² | 12 | 0 | 0 | 0 | 0 | 0 | 2.7% |
| 24² | 12 | 0 | 0 | 0 | 0 | 0.3% | 3.8% |
| 32² | 12 | 0 | 0 | 0.3% | 0 | 0 | 6.2% |

Bigger tiles (16² = 256 tiles) are the most robust — more pixels averaged per
bit. **0 bit-errors down to ×0.5**, single-digit % at ×0.35. (The small ×0.9
blips at 32² are fractional-tile-boundary rounding jitter; a 1-pixel tile guard
band would smooth them. Higher Δ already suppresses them.)

## 2. Baseline — block-DCT/QIM under the same downscale

| channel | BER |
|---------|-----|
| none / jpeg85 | 0% |
| ×0.9 | 50.4% |
| ×0.75 | 50.5% |
| ×0.5 | 49.3% |
| ×0.35 | 53.9% |

Block-DCT is **~50% (a coin flip) at every scale** — destroyed. This is exactly
the limitation coarse mode removes.

## 3. Real message survival through a downscale

18-byte message, interleaved repetition ECC, 32² grid (1024 tiles), Δ=8:

| R | ×0.5 | ×0.35 |
|---|------|-------|
| 3 | ✓ EXACT | ✓ EXACT |
| 7 | ✓ EXACT | ✓ EXACT |

A real message comes back **byte-exact** through a ×0.5 (and even ×0.35)
downscale + JPEG.

## Conclusion / recommendation

- **It works and it's honest for the messenger case.** Coarse tile-mean QIM
  survives uniform downscaling that annihilates block-DCT. Recommended params:
  16²–24² tiles, Δ≈8–12, light repetition ECC.
- **The cost is capacity.** One bit per tile → 16² = 256 bits ≈ 32 bytes raw,
  ~10 bytes after R=3 ECC; 32² ≈ 128 bytes raw, ~40 bytes with ECC. This is the
  fundamental robustness↔capacity trade-off: enough for a URL, coordinates, a
  short key or note — not paragraphs.
- **Perceptual cost & scope.** A per-tile DC offset with hard edges can show as
  faint blocking; feathering the offset across tile borders is the obvious next
  refinement. This prototype handles **uniform scale only** — cropping or padding
  shifts content vs the fractional grid and needs an added sync marker + offset
  search. Rotation is out of scope (that's the Fourier-Mellin territory).

Next step: if we ship it, wrap `coarse.ts` in a framed + ECC codec (like
`robust.ts` wraps `dct.ts`) and add it as a third mode — "Resize-robust (small
payload)" — with the capacity clearly labelled.

Reproduce: `bun tools/resize-robustness/harness.mjs` (needs Python + PIL).
