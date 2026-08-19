// main.ts — bootstrap: register the service worker (offline) and wire the UI.
import { registerSW } from "virtual:pwa-register";
import { initUI } from "./ui";
import { initInstall } from "./install";
import "./styles.css";

registerSW({ immediate: true });
initUI();
initInstall();
