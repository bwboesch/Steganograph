// main.portable.ts — entry for the single-file, sendable build.
// No service worker: the whole app is one HTML file, so it is already offline
// and self-contained. Just wire the UI.
import { initUI } from "./ui";
import "./styles.css";

initUI();
