import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }))
import { POST } from "./route"
const sessionId = "00000000-0000-4000-8000-000000000001"
const token = "00000000-0000-4000-8000-000000000002"
function request(body: unknown, auth = "Bearer test-jwt") {
  return new Request("http://localhost/api/vision/consent", {
    method: "POST",
    headers: { Authorization: auth },
    body: JSON.stringify(body),
  })
}
describe("POST /api/vision/consent", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key")
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "owner" } },
      error: null,
    })
    mocks.createClient.mockReturnValue({
      auth: { getUser: mocks.getUser },
      rpc: mocks.rpc,
    })
    mocks.rpc.mockResolvedValue({ data: token, error: null })
  })
  afterEach(() => vi.unstubAllEnvs())
  it("requires authenticated opt-in", async () => {
    expect((await POST(request({ sessionId, enabled: true }, ""))).status).toBe(
      401,
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it("rejects invalid input", async () => {
    expect(
      (await POST(request({ sessionId: "invalid", enabled: "yes" }))).status,
    ).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each([true, false])(
    "sets consent %s with no-store and hides disabled tokens",
    async (enabled) => {
      const response = await POST(request({ sessionId, enabled }))
      expect(response.status).toBe(200)
      expect(response.headers.get("Cache-Control")).toBe("no-store")
      expect(await response.json()).toEqual({
        consentToken: enabled ? token : null,
      })
      expect(mocks.rpc).toHaveBeenCalledWith("set_vision_consent", {
        p_session_id: sessionId,
        p_enabled: enabled,
      })
    },
  )
})
