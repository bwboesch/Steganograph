// ui.ts — DOM wiring for the Hide / Reveal panels. All heavy lifting lives in
// the DOM-free engine; this module only moves pixels between <input>, <canvas>
// and the codec, and reports status.

import { encode, decode, messageCapacityBytes } from "./engine/codec";

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

/** Render ImageData to the canvas and hand back a lossless PNG blob. */
function imageDataToPngBlob(image: ImageData, canvas: HTMLCanvasElement): Promise<Blob> {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.putImageData(image, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"),
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
  const hideCanvas = $<HTMLCanvasElement>("hide-canvas");
  let carrier: ImageData | null = null;

  hideImage.addEventListener("change", async () => {
    const file = hideImage.files?.[0];
    if (!file) return;
    try {
      carrier = await fileToImageData(file, hideCanvas);
      const cap = messageCapacityBytes(carrier);
      hideCapacity.textContent = `Capacity: ~${cap.toLocaleString()} bytes (${carrier.width}×${carrier.height}). Encryption adds ~44 bytes of overhead.`;
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
    hideRun.disabled = true;
    setStatus(hideStatus, "Embedding…");
    try {
      const stego = await encode(carrier, message, hidePassword.value || undefined);
      const blob = await imageDataToPngBlob(stego, hideCanvas);
      download(blob, "stego.png");
      setStatus(
        hideStatus,
        hidePassword.value
          ? "Done — encrypted message embedded. Downloaded stego.png."
          : "Done — message embedded (plaintext). Downloaded stego.png.",
        "ok",
      );
    } catch (e) {
      setStatus(hideStatus, String(e instanceof Error ? e.message : e), "error");
    } finally {
      hideRun.disabled = false;
    }
  });

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
      const message = await decode(stegoImage, revealPassword.value || undefined);
      revealOutput.value = message;
      revealOutputField.hidden = false;
      setStatus(revealStatus, "Message revealed.", "ok");
    } catch (e) {
      setStatus(revealStatus, String(e instanceof Error ? e.message : e), "error");
    } finally {
      revealRun.disabled = false;
    }
  });
}
