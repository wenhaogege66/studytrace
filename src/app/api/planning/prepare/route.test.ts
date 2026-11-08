import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUser: vi.fn(),
  createClient: vi.fn(),
  prepare: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }))
vi.mock("@/lib/planning/generate", () => ({
  prepareLearningPlan: mocks.prepare,
}))

import { POST } from "./route"

function request(body: unknown, authorized = true) {
  return new Request("http://localhost/api/planning/prepare", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorized ? { Authorization: "Bearer test-jwt" } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("planning API authentication and quotas", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-only-publishable")
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "owner" } },
      error: null,
    })
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    mocks.createClient.mockReturnValue({
      auth: { getUser: mocks.getUser },
      rpc: mocks.rpc,
    })
  })
  it("rejects missing auth and invalid bodies before consuming quota", async () => {
    expect((await POST(request({}, false))).status).toBe(401)
    expect(
      (await POST(request({ intent: " ", round: 0, answers: {} }))).status,
    ).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it("fails closed on quota errors and exhaustion", async () => {
    const body = { intent: "复习函数", round: 0, answers: {} }
    mocks.rpc.mockResolvedValueOnce({
      error: { message: "db failure" },
      data: null,
    })
    expect((await POST(request(body))).status).toBe(503)
    mocks.rpc.mockResolvedValueOnce({ error: null, data: false })
    expect((await POST(request(body))).status).toBe(429)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it("returns no-store results and hides raw provider errors", async () => {
    const body = { intent: "复习函数", round: 0, answers: {} }
    mocks.prepare.mockResolvedValueOnce({
      kind: "questions",
      questions: [],
      explanation: "澄清",
    })
    const response = await POST(request(body))
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    mocks.prepare.mockRejectedValueOnce(new Error("secret provider payload"))
    const failed = await POST(request(body))
    expect(failed.status).toBe(503)
    expect(JSON.stringify(await failed.json())).not.toContain("secret")
  })
  it("rejects oversized requests before provider processing", async () => {
    expect((await POST(request({ intent: "a".repeat(40_000) }))).status).toBe(
      413,
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
