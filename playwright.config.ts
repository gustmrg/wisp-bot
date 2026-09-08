import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  use: { ignoreHTTPSErrors: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--ignore-certificate-errors"] } },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
