// install.ts — Android "Add to Home Screen" UX.
//
// Chrome fires `beforeinstallprompt` when the PWA meets install criteria
// (valid manifest, service worker with a fetch handler, served over trusted
// HTTPS). We capture it and surface an in-app Install button so the user does
// not have to hunt through the browser menu. Hidden when already installed.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function initInstall(): void {
  const btn = document.getElementById("install-btn") as HTMLButtonElement | null;
  if (!btn) return;

  // Already running as an installed app → nothing to offer.
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (isStandalone) return;

  let deferred: BeforeInstallPromptEvent | null = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // stop Chrome's default mini-infobar; we drive it ourselves
    deferred = e as BeforeInstallPromptEvent;
    btn.hidden = false;
  });

  btn.addEventListener("click", async () => {
    if (!deferred) return;
    btn.disabled = true;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    btn.hidden = true;
  });
}
