import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  create: vi.fn(),
  rpc: vi.fn(),
}))
vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({ auth: { getSession: mocks.session } }),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.create }))
import { setMyConsent } from "@/lib/privacy/consents"
describe("consent requests bind to the user's clicked identity", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable")
    mocks.session.mockResolvedValue({
      data: { session: { user: { id: "A" }, access_token: "token-A" } },
    })
    mocks.create.mockReturnValue({ rpc: mocks.rpc })
    mocks.rpc.mockResolvedValue({ data: {}, error: null })
  })
  it("uses the captured bearer token in a nonpersistent client", async () => {
    await setMyConsent("ai_reports", true, "A")
    expect(mocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        global: { headers: { Authorization: "Bearer token-A" } },
        auth: expect.objectContaining({ persistSession: false }),
      }),
    )
  })
  it("refuses a follow-on grant after account A changed to B", async () => {
    mocks.session.mockResolvedValue({
      data: { session: { user: { id: "B" }, access_token: "token-B" } },
    })
    await expect(setMyConsent("weekly_reports", true, "A")).rejects.toThrow(
      /身份已变化/,
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it("does not publish an A response into B's UI", async () => {
    mocks.rpc.mockImplementation(async () => {
      mocks.session.mockResolvedValue({
        data: { session: { user: { id: "B" }, access_token: "token-B" } },
      })
      return { data: {}, error: null }
    })
    const changed = vi.fn()
    window.addEventListener("studytrace:consent-changed", changed)
    await expect(setMyConsent("ai_reports", true, "A")).rejects.toThrow(
      /身份已变化/,
    )
    expect(changed).not.toHaveBeenCalled()
    window.removeEventListener("studytrace:consent-changed", changed)
  })
})
