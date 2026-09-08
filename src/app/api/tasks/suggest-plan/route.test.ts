import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generateTaskPlan: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}))

vi.mock("@/lib/ai/task-plan", () => ({
  generateTaskPlan: mocks.generateTaskPlan,
}))

import { POST } from "./route"

const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const originalPublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

function request(
  body: unknown,
  authorization: string | undefined = "Bearer anonymous-jwt",
) {
  const headers = new Headers({ "Content-Type": "application/json" })
  if (authorization) headers.set("Authorization", authorization)

  return new Request("http://localhost/api/tasks/suggest-plan", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

describe("POST /api/tasks/suggest-plan", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-test-key"

    mocks.getUser.mockResolvedValue({
      data: { user: { id: "anonymous-user" } },
      error: null,
    })
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    mocks.createClient.mockReturnValue({
      auth: { getUser: mocks.getUser },
      rpc: mocks.rpc,
    })
  })

  afterEach(() => {
    if (originalSupabaseUrl === undefined)
      delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl

    if (originalPublishableKey === undefined)
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    else
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = originalPublishableKey
  })

  it("rejects requests without an anonymous bearer token", async () => {
    const response = await POST(request({ title: "复习数学" }, ""))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: "匿名体验已失效，请刷新后重试",
    })
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.generateTaskPlan).not.toHaveBeenCalled()
  })

  it("rejects malformed task input before consuming quota", async () => {
    const response = await POST(request({ title: "   " }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "请提供 1～120 字的任务标题",
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.generateTaskPlan).not.toHaveBeenCalled()
  })

  it("falls back cleanly when the quota RPC cannot be checked", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    })

    const response = await POST(request({ title: "复习数学" }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "AI 配额暂时无法校验，可继续手动填写",
    })
    expect(mocks.generateTaskPlan).not.toHaveBeenCalled()
  })

  it("rate-limits a user whose generation quota is exhausted", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null })

    const response = await POST(request({ title: "复习数学" }))

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({
      error: "当前匿名会话或今日 AI 配额已达上限，请稍后再试",
    })
    expect(mocks.rpc).toHaveBeenCalledWith("consume_ai_generation_quota")
    expect(mocks.generateTaskPlan).not.toHaveBeenCalled()
  })

  it("returns an editable three-step suggestion for an authenticated anonymous user", async () => {
    const suggestion = {
      steps: ["列出公式范围", "完成两组习题", "检查并记录错题"],
      priority: "high",
      estimatedMinutes: 45,
      observationProfile: "study_paper_v1",
      profileReason: "纸笔做题会自然低头",
    }
    mocks.generateTaskPlan.mockResolvedValue(suggestion)

    const response = await POST(
      request({ title: "复习数学", estimatedMinutes: 40 }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual(suggestion)
    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "publishable-test-key",
      expect.objectContaining({
        global: { headers: { Authorization: "Bearer anonymous-jwt" } },
      }),
    )
    expect(mocks.getUser).toHaveBeenCalledWith("anonymous-jwt")
    expect(mocks.generateTaskPlan).toHaveBeenCalledWith(
      {
        title: "复习数学",
        estimatedMinutes: 40,
      },
      expect.any(AbortSignal),
    )
  })

  it("reports missing Qwen configuration without exposing configuration details", async () => {
    mocks.generateTaskPlan.mockRejectedValue(new Error("QWEN_NOT_CONFIGURED"))

    const response = await POST(request({ title: "复习数学" }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "AI 步骤生成尚未配置，可继续手动填写",
    })
  })

  it("turns provider failures into a safe manual-entry fallback", async () => {
    const providerError = new Error("upstream detail must stay private")
    providerError.name = "AI_APICallError"
    mocks.generateTaskPlan.mockRejectedValue(providerError)

    const response = await POST(request({ title: "复习数学" }))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: "AI 暂时没有响应，可继续手动填写",
    })
  })
})
