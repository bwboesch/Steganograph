// ui.ts — DOM wiring for the Hide / Reveal panels. All heavy lifting lives in
// the DOM-free engine; this module only moves pixels between <input>, <canvas>
// and the codec, and reports status.

import { encode, decode, messageCapacityBytes } from "./engine/codec";
import { encodeRobust, decodeRobust, robustMessageCapacityBytes } from "./engine/robust";
import { encodeResilient, decodeResilient, resilientMessageCapacityBytes } from "./engine/resilient";

type Mode = "lossless" | "robust" | "resilient";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** Decode a File into ImageData via a canvas (opaque, natural size). */
async function fileToImageData(file: File, canvas: HTMLCanvasElement): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Render ImageData to the canvas and hand back an encoded blob. Lossless mode
 * exports PNG (LSB needs exact bytes); robust mode exports JPEG at high quality
 * — its DCT/QIM payload is built to survive exactly that recompression.
 */
function imageDataToBlob(
  image: ImageData,
  canvas: HTMLCanvasElement,
  type: "image/png" | "image/jpeg",
): Promise<Blob> {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("image export failed"))),
      type,
      type === "image/jpeg" ? 0.92 : undefined,
    ),
  );
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(el: HTMLElement, message: string, kind: "" | "ok" | "error" = ""): void {
  el.textContent = message;
  el.className = "status" + (kind ? ` status--${kind}` : "");
}

export function initUI(): void {
  // --- tab switching --------------------------------------------------------
  const tabHide = $("tab-hide");
  const tabReveal = $("tab-reveal");
  const panelHide = $("panel-hide");
  const panelReveal = $("panel-reveal");

  function selectTab(hide: boolean): void {
    tabHide.classList.toggle("tab--active", hide);
    tabReveal.classList.toggle("tab--active", !hide);
    tabHide.setAttribute("aria-selected", String(hide));
    tabReveal.setAttribute("aria-selected", String(!hide));
    panelHide.hidden = !hide;
    panelReveal.hidden = hide;
  }
  tabHide.addEventListener("click", () => selectTab(true));
  tabReveal.addEventListener("click", () => selectTab(false));

  // --- Hide -----------------------------------------------------------------
  const hideImage = $<HTMLInputElement>("hide-image");
  const hideMessage = $<HTMLTextAreaElement>("hide-message");
  const hidePassword = $<HTMLInputElement>("hide-password");
  const hideRun = $<HTMLButtonElement>("hide-run");
  const hideStatus = $("hide-status");
  const hideCapacity = $("hide-capacity");
  const hideHint = $("hide-hint");
  const hideCanvas = $<HTMLCanvasElement>("hide-canvas");
  const modeWarning = $("mode-warning");
  let carrier: ImageData | null = null;

  const currentMode = (): Mode =>
    ($<HTMLInputElement>("mode-resilient").checked && "resilient") ||
    ($<HTMLInputElement>("mode-robust").checked && "robust") ||
    "lossless";

  const asJpeg = (m: Mode): boolean => m === "robust" || m === "resilient";

  const WARNINGS: Record<Mode, string> = {
    lossless: "",
    robust:
      "⚠ Robust mode survives re-encoding but NOT resizing. Messengers that shrink images (WhatsApp, Instagram) will still wipe the message. Lower capacity than lossless.",
    resilient:
      "⚠ Resize-robust mode survives re-encoding AND uniform downscaling (most messengers), but NOT cropping or rotation. Capacity is tiny and fixed (~79 bytes / ~35 encrypted). Use a reasonably large carrier image.",
  };

  function refreshMode(): void {
    const m = currentMode();
    modeWarning.hidden = m === "lossless";
    modeWarning.innerHTML = WARNINGS[m].replace(/(re-encoding|resizing|downscaling|cropping|rotation|NOT)/g, "<strong>$1</strong>");
    hideRun.textContent = asJpeg(m) ? "Embed & download JPEG" : "Embed & download PNG";
    hideHint.textContent = {
      lossless: "Output is a lossless PNG. Share it unchanged — re-encoding wipes it.",
      robust: "Output is a JPEG. It survives re-encoding, but any resize (most messengers) wipes it.",
      resilient: "Output is a JPEG. It survives re-encoding and downscaling — good for messengers.",
    }[m];
    if (carrier) showCapacity();
  }

  function showCapacity(): void {
    if (!carrier) return;
    const m = currentMode();
    const cap =
      m === "resilient"
        ? resilientMessageCapacityBytes()
        : m === "robust"
          ? robustMessageCapacityBytes(carrier)
          : messageCapacityBytes(carrier);
    const label = m === "lossless" ? "Capacity" : m === "robust" ? "Robust capacity" : "Resize-robust capacity";
    const fixed = m === "resilient" ? " (fixed)" : "";
    hideCapacity.textContent = `${label}: ~${cap.toLocaleString()} bytes${fixed} (${carrier.width}×${carrier.height}). Encryption adds ~44 bytes of overhead.`;
  }

  for (const el of document.querySelectorAll<HTMLInputElement>('input[name="hide-mode"]')) {
    el.addEventListener("change", refreshMode);
  }

  hideImage.addEventListener("change", async () => {
    const file = hideImage.files?.[0];
    if (!file) return;
    try {
      carrier = await fileToImageData(file, hideCanvas);
      showCapacity();
      setStatus(hideStatus, "");
    } catch (e) {
      carrier = null;
      hideCapacity.textContent = "Could not read that image.";
      setStatus(hideStatus, String(e instanceof Error ? e.message : e), "error");
    }
  });

  hideRun.addEventListener("click", async () => {
    if (!carrier) return setStatus(hideStatus, "Load a carrier image first.", "error");
    const message = hideMessage.value;
    if (!message) return setStatus(hideStatus, "Type a message to conceal.", "error");
    const m = currentMode();
    const password = hidePassword.value || undefined;
    hideRun.disabled = true;
    setStatus(hideStatus, "Embedding…");
    try {
      const stego =
        m === "resilient"
          ? await encodeResilient(carrier, message, password)
          : m === "robust"
            ? await encodeRobust(carrier, message, password)
            : await encode(carrier, message, password);
      const jpeg = asJpeg(m);
      const blob = await imageDataToBlob(stego, hideCanvas, jpeg ? "image/jpeg" : "image/png");
      const name = jpeg ? "stego.jpg" : "stego.png";
      download(blob, name);
      const enc = password ? "encrypted message" : "message (plaintext)";
      setStatus(hideStatus, `Done — ${enc} embedded. Downloaded ${name}.`, "ok");
    } catch (e) {
      setStatus(hideStatus, String(e instanceof Error ? e.message : e), "error");
    } finally {
      hideRun.disabled = false;
    }
  });

  refreshMode();

  // --- Reveal ---------------------------------------------------------------
  const revealImage = $<HTMLInputElement>("reveal-image");
  const revealPassword = $<HTMLInputElement>("reveal-password");
  const revealRun = $<HTMLButtonElement>("reveal-run");
  const revealStatus = $("reveal-status");
  const revealOutput = $<HTMLTextAreaElement>("reveal-output");
  const revealOutputField = $("reveal-output-field");
  const revealCanvas = $<HTMLCanvasElement>("reveal-canvas");
  let stegoImage: ImageData | null = null;

  revealImage.addEventListener("change", async () => {
    const file = revealImage.files?.[0];
    if (!file) return;
    try {
      stegoImage = await fileToImageData(file, revealCanvas);
      setStatus(revealStatus, "");
    } catch (e) {
      stegoImage = null;
      setStatus(revealStatus, String(e instanceof Error ? e.message : e), "error");
    }
  });

  revealRun.addEventListener("click", async () => {
    if (!stegoImage) return setStatus(revealStatus, "Load a stego image first.", "error");
    revealRun.disabled = true;
    setStatus(revealStatus, "Reading…");
    revealOutputField.hidden = true;
    try {
      const { message, mode } = await revealAny(stegoImage, revealPassword.value || undefined);
      revealOutput.value = message;
      revealOutputField.hidden = false;
      setStatus(revealStatus, `Message revealed (${mode} mode).`, "ok");
    } catch (e) {
      setStatus(revealStatus, String(e instanceof Error ? e.message : e), "error");
    } finally {
      revealRun.disabled = false;
    }
  });
}

/**
 * Try each codec in turn. A "bad magic" error means that codec's header simply
 * isn't present → try the next. Any *definitive* error (valid header but
 * wrong/missing password, etc.) surfaces immediately instead of masquerading as
 * the next mode.
 */
async function revealAny(
  image: ImageData,
  password?: string,
): Promise<{ message: string; mode: Mode }> {
  const chain: [Mode, (i: ImageData, p?: string) => Promise<string>][] = [
    ["lossless", decode],
    ["robust", decodeRobust],
    ["resilient", decodeResilient],
  ];
  for (let i = 0; i < chain.length; i++) {
    const [mode, fn] = chain[i];
    try {
      return { message: await fn(image, password), mode };
    } catch (e) {
      const isBadMagic = /bad magic/i.test(String(e instanceof Error ? e.message : e));
      if (!isBadMagic || i === chain.length - 1) throw e;
    }
  }
  throw new Error("no hidden message found");
}
