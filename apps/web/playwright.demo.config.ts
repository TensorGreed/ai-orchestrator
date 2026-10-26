import { defineConfig, devices } from "@playwright/test";

// The static demo (`vite build --mode demo`) served by `vite preview` under /demo/.
// No API and no database: the demo answers in the browser. The port is its own
// so it never collides with a dev API (4000), docs (4173) or web (5173) server.
const port = Number(process.env.DEMO_PORT ?? 4319);

export default defineConfig({
  testDir: "./e2e-demo",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "playwright-report-demo" }]] : "list",
  outputDir: "test-results-demo",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // A preinstalled Chromium of another Playwright release can be named here.
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {})
      }
    }
  ],
  webServer: {
    command: `pnpm build:demo && pnpm exec vite preview --mode demo --port ${port} --strictPort`,
    url: `http://localhost:${port}/demo/`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI
  }
});
