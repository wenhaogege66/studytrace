import { defineConfig, devices } from "@playwright/test"

const baseURL = "http://127.0.0.1:3102"
export default defineConfig({
  testDir: "./e2e",
  testMatch: /guided-planning\.spec\.ts$/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "list",
  outputDir: "output/playwright/planning-results",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command:
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_e2e NEXT_PUBLIC_TURNSTILE_SITE_KEY= pnpm dev --hostname 127.0.0.1 --port 3102",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
