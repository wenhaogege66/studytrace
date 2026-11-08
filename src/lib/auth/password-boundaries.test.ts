import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const read = (path: string) =>
  readFileSync(`${process.cwd()}/src/${path}`, "utf8")
describe("password production boundaries", () => {
  it("local Auth uses password accounts without email confirmation or manual linking", () => {
    const config = readFileSync(
      path.join(process.cwd(), "supabase/config.toml"),
      "utf8",
    )
    expect(config).toContain("enable_manual_linking = false")
    expect(config).toContain("minimum_password_length = 8")
    expect(config).toMatch(
      /\[auth\.email\][\s\S]*?enable_confirmations = false/,
    )
  })
  it("uses only public Supabase credentials in browser auth", () => {
    const client = read("lib/supabase/client.ts")
    expect(client).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    expect(client).not.toMatch(/SERVICE_ROLE|SUPABASE_SECRET_KEY|admin\./)
  })
  it("does not expose retired OTP, merge or service-role operations", () => {
    const repo = read("lib/auth/account-repository.ts")
    expect(repo).not.toMatch(
      /signInWithOtp|verifyOtp|prepare_account_merge|consume_account_merge|SERVICE_ROLE|\.admin\./,
    )
    expect(repo).toMatch(
      /transient\.rpc\(\s*"delete_my_password_account",?\s*\)/,
    )
    expect(repo).not.toMatch(/rpc\([^)]*password[,}]/)
  })
  it("requires both fresh AMR and a real same-owner live session for SQL deletion", () => {
    const migration = readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20261108080437_password_account_auth.sql",
      ),
      "utf8",
    )
    expect(migration).toContain("caller_id uuid := auth.uid()")
    expect(migration).toContain("entry->>'method' = 'password'")
    expect(migration).toContain("from auth.sessions")
    expect(migration).toContain(
      "id = caller_session_id and user_id = caller_id",
    )
    expect(migration).toContain(
      "session_created_at < checked_at - interval '5 minutes'",
    )
    expect(migration).not.toContain("raw_user_meta_data")
    expect(migration).toContain("from public, anon, authenticated")
  })
})
