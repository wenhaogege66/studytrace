import { defineConfig } from "@playwright/test"
import base from "../playwright.config"

const baseURL = "http://127.0.0.1:3025"
export default defineConfig({
  ...base,
  testDir: ".",
  testIgnore: [/\.local\.spec\.ts$/, /turnstile-failure\.spec\.ts$/],
  workers: 2,
  use: { ...base.use, baseURL },
  outputDir: "../output/playwright/mocked-results",
  webServer: {
    command:
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_e2e NEXT_PUBLIC_TURNSTILE_SITE_KEY= pnpm dev --hostname 127.0.0.1 --port 3025",
    cwd: "..",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
