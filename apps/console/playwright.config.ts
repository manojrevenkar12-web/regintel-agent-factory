import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.RIF_CONSOLE_URL ?? "http://localhost:8787",
    viewport: { width: 1280, height: 900 },
  },
  reporter: [["list"]],
});
