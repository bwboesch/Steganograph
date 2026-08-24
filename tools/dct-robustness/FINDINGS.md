# DCT robustness — measured findings

Goal: before building a shipped "robust mode", measure how well DCT-domain
embedding actually survives JPEG recompression. Method: QIM on one mid-frequency
coefficient of each 8×8 luminance block (`src/engine/dct.ts`), 1 bit/block, run
through the **real** JPEG compressor (PIL) via `harness.mjs`.

Cover: 512×512, gradients + texture + shapes → 4096 blocks (bits) capacity.

## 1. Pure JPEG recompression (no resize)

Raw bit-error-rate at full capacity:

| step | none | Q95 | Q90 | Q85 | Q80 | Q75 | Q70 | Q60 |
|------|------|-----|-----|-----|-----|-----|-----|-----|
| Δ=12 | 0 | 0 | 0 | 0 | 0.3% | 0.0% | 0.1% | 25.3% |
| Δ=20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Δ=28 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Δ=40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

A 40-byte message survives **exactly** at Δ≥20, Q≥70 — even with **no** ECC
(R=1). Repetition ECC (R=5, R=11) adds margin but isn't needed here.

**Verdict:** against pure quality-recompression, DCT/QIM is strong. Δ≈24 is a
good default (0 errors to Q60, modest visual impact).

## 2. With downscaling — the realistic messenger case

Messengers (WhatsApp, Instagram, …) don't just re-JPEG; they **resize**. That
shifts the 8×8 block grid, which block-aligned QIM cannot follow. Downscale →
JPEG(Q85) → upscale back to original size:

| step | ×0.9 | ×0.75 | ×0.5 |
|------|------|-------|------|
| Δ=28 | 5.8% | 21.4% | 50.4% |
| Δ=40 | 1.1% | 11.4% | 44.4% |

At ×0.5 the BER is ~50% — the payload is destroyed; no ECC recovers that. Even a
gentle ×0.75 (11–21% BER) needs very heavy ECC and low payload to survive.

**Verdict:** block-DCT/QIM does **not** survive resizing. This is the true
blocker for "share over any messenger", and it matches the theory.

## Conclusion / recommendation

- A shipped **"Robust (JPEG)" mode** is worthwhile and honest for cases where the
  image is **not resized**: email attachments, Telegram "send as file", Signal
  original-quality, cloud-drive links, AirDrop, re-saving/format conversion. Use
  Δ≈24, embed in luma, keep 1 bit/block, add light interleaved-repetition ECC
  (R=3) for margin. Label it clearly: *survives re-encoding, NOT resizing.*
- To survive **resizing** would require a resync/resolution-independent scheme
  (sync templates, log-polar/Fourier-domain marks, or feature-anchored blocks) —
  a much larger research effort. Out of scope for the next increment.

Reproduce: `bun tools/dct-robustness/harness.mjs` (needs Python + PIL).
