import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  analyze: vi.fn(),
  configuration: vi.fn(),
}))
vi.mock("@/lib/server/api", async () => ({
  ...(await vi.importActual("@/lib/server/api")),
  authenticateRequest: mocks.authenticate,
}))
vi.mock("@/lib/ai/observation", () => ({
  analyzeObservation: mocks.analyze,
  visionConfiguration: mocks.configuration,
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mocks.finish }),
}))
import { POST } from "@/app/api/observation/analyze/route"
const agreement = {
  phone: "restricted",
  tablet: "ignored",
  absenceSeconds: 60,
  screenDirection: false,
}
function request(body?: unknown) {
  return new Request("http://localhost/api/observation/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      body ?? {
        sessionId: crypto.randomUUID(),
        windowId: crypto.randomUUID(),
        frames: [0, 2, 4, 6].map((sec) => ({
          capturedAt: new Date(Date.now() - 6000 + sec * 1000).toISOString(),
          image: "data:image/jpeg;base64,YWJj",
        })),
      },
    ),
  })
}
describe("authorized bounded cloud observation API", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-server-only")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co")
    mocks.configuration.mockReturnValue({ model: "test" })
    mocks.authenticate.mockResolvedValue({ supabase: { rpc: mocks.reserve } })
    mocks.reserve.mockResolvedValue({
      data: { status: "reserved", agreement },
      error: null,
    })
    mocks.analyze.mockResolvedValue({
      result: { quality: "good", phone: "possible", tablet: "unknown" },
      model: "test",
      usage: { inputTokens: 2, outputTokens: 3 },
    })
    mocks.finish.mockResolvedValue({
      data: { status: "complete", candidate_event_ids: [] },
      error: null,
    })
  })
  it("reserves with user identity and persists only structured output", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.reserve).toHaveBeenCalledWith(
      "prepare_cloud_observation",
      expect.objectContaining({ p_session_id: expect.any(String) }),
    )
    expect(mocks.finish.mock.calls[0][1]).not.toHaveProperty("frames")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
  it("does not contact provider without explicit deployment enablement", async () => {
    mocks.configuration.mockReturnValue(null)
    expect((await POST(request())).status).toBe(503)
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.reserve).not.toHaveBeenCalled()
  })
  it("fails closed on missing consent, stopped session or quota", async () => {
    mocks.reserve.mockResolvedValue({ data: null, error: { code: "42501" } })
    expect((await POST(request())).status).toBe(403)
    expect(mocks.analyze).not.toHaveBeenCalled()
    mocks.reserve.mockResolvedValue({ data: null, error: { code: "P0001" } })
    expect((await POST(request())).status).toBe(429)
  })
  it("does not repeat paid/provider work for a cached window", async () => {
    mocks.reserve.mockResolvedValue({
      data: { status: "complete", result: { quality: "unknown" } },
      error: null,
    })
    expect((await POST(request())).status).toBe(200)
    expect(mocks.analyze).not.toHaveBeenCalled()
  })
  it("bounds even chunked request bodies and rejects remote image URLs", async () => {
    expect((await POST(request({ padding: "x".repeat(750001) }))).status).toBe(
      413,
    )
    expect((await POST(request({ frames: [] }))).status).toBe(400)
    expect(mocks.analyze).not.toHaveBeenCalled()
  })
  it("does not expose SDK errors containing submitted media", async () => {
    mocks.analyze.mockRejectedValue(
      new Error("image=data:image/jpeg;base64,secret-frame"),
    )
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("secret-frame")
  })
})
