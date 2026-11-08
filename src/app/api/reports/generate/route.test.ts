import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  runReportJob: vi.fn(),
}))
vi.mock("@/lib/server/api", async (original) => ({
  ...(await original<typeof import("@/lib/server/api")>()),
  authenticateRequest: mocks.authenticateRequest,
}))
vi.mock("@/lib/reports/service", () => ({ runReportJob: mocks.runReportJob }))
import { ApiError } from "@/lib/server/api"
import { POST } from "./route"

function request(body: unknown) {
  return new Request("https://example.com/api/reports/generate", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("manual learning report route", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.authenticateRequest.mockResolvedValue({
      user: { id: "verified-owner" },
    })
    mocks.runReportJob.mockResolvedValue({ state: "ready", reportId: "r1" })
  })
  it("requires verified identity before consuming any quota", async () => {
    mocks.authenticateRequest.mockRejectedValue(new ApiError(401, "请重新进入"))
    expect((await POST(request({ days: 7 }))).status).toBe(401)
    expect(mocks.runReportJob).not.toHaveBeenCalled()
  })
  it("never accepts a caller supplied owner or report snapshot", async () => {
    await POST(
      request({ days: 30, user_id: "victim", snapshot: { fake: true } }),
    )
    expect(mocks.runReportJob).toHaveBeenCalledWith(
      "verified-owner",
      30,
      "manual",
      expect.any(AbortSignal),
    )
  })
  it("rejects unsupported windows and returns cache/no-store state", async () => {
    expect((await POST(request({ days: 90 }))).status).toBe(400)
    expect(mocks.runReportJob).not.toHaveBeenCalled()
    mocks.runReportJob.mockResolvedValue({ state: "cached", reportId: "r1" })
    const response = await POST(request({ days: 7 }))
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ state: "cached", reportId: "r1" })
  })
  it("returns explicit quota and sanitized provider failures", async () => {
    mocks.runReportJob.mockResolvedValue({ state: "quota" })
    expect((await POST(request({ days: 7 }))).status).toBe(429)
    mocks.runReportJob.mockRejectedValue(new Error("raw provider key"))
    const response = await POST(request({ days: 7 }))
    expect(await response.text()).not.toContain("raw provider key")
  })
})
