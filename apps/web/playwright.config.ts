import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const webRoot = path.resolve(path.dirname(currentFilePath));
const repoRoot = path.resolve(webRoot, "..", "..");

const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 15_000
  },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "pnpm e2e:dev",
    cwd: repoRoot,
    url: "http://localhost:5173",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      API_PORT: "4000",
      WEB_ORIGIN: "http://localhost:5173",
      DB_TYPE: "sqlite",
      SEED_SAMPLE_WORKFLOWS: "true",
      COOKIE_SECURE: "false",
      AUTH_ALLOW_PUBLIC_REGISTER: "false",
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      SECRET_MASTER_KEY_BASE64: "9FdQxNjmCb9J3LArvgV9mrn1x5XieXf0WqN7h6q2TSA=",
      WORKER_MODE: "all"
    }
  }
});
