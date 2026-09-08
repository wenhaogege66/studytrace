import { execFileSync } from "node:child_process"

import { defineConfig, devices } from "@playwright/test"

type LocalSupabaseStatus = {
  API_URL: string
  DB_URL: string
  MAILPIT_URL: string
  PUBLISHABLE_KEY: string
  SECRET_KEY: string
}

const localSupabase = JSON.parse(
  execFileSync("npx", ["supabase", "status", "-o", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }),
) as LocalSupabaseStatus

process.env.STUDYTRACE_LOCAL_AUTH_E2E = "true"
process.env.STUDYTRACE_LOCAL_API_URL = localSupabase.API_URL
process.env.STUDYTRACE_LOCAL_DB_URL = localSupabase.DB_URL
process.env.STUDYTRACE_LOCAL_MAILPIT_URL = localSupabase.MAILPIT_URL
process.env.STUDYTRACE_LOCAL_SECRET_KEY = localSupabase.SECRET_KEY

const port = 3200
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./e2e",
  testMatch: /account-sync\.local\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "output/playwright/local-auth-results",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: [
      `NEXT_PUBLIC_SUPABASE_URL=${JSON.stringify(localSupabase.API_URL)}`,
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${JSON.stringify(localSupabase.PUBLISHABLE_KEY)}`,
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY=",
      `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    ].join(" "),
    url: baseURL,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
})
