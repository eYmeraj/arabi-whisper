import { defineConfig } from "@playwright/test";

// The page in Chrome, with Spotify, Gemini, LRCLIB and the sync Worker simulated (e2e/fakes.js).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  use: { channel: "chrome" },
  webServer: { command: "npm start", url: "http://127.0.0.1:8000/", reuseExistingServer: true },
});
