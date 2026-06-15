import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  expect: {
    timeout: 8000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:8788",
    reuseExistingServer: !process.env.CI,
    timeout: 300000,
  },
});
