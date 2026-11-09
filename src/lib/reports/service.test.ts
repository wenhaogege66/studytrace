import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  configured: vi.fn(),
  generate: vi.fn(),
  parse: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/supabase-service", () => ({
  getServiceSupabase: () => ({ rpc: mocks.rpc }),
}))
vi.mock("./generator", () => ({
  reportProviderConfigured: mocks.configured,
  generateLearningReport: mocks.generate,
}))
vi.mock("./contracts", () => ({ reportSnapshotSchema: { parse: mocks.parse } }))

import { runReportJob } from "./service"

describe("learning report leases", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.configured.mockReturnValue(true)
    mocks.parse.mockReturnValue({ version: 1 })
    mocks.generate.mockResolvedValue({
      content: { title: "report" },
      modelId: "configured-model",
      usage: { total_tokens: 24 },
    })
  })
  it("does not consume database quota if provider is not configured", async () => {
    mocks.configured.mockReturnValue(false)
    await expect(runReportJob("owner", 7, "manual")).rejects.toMatchObject({
      status: 503,
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it("never calls the model for cached, quota, pending or no-new-records states", async () => {
    for (const state of ["cached", "quota", "pending", "no_new_records"]) {
      mocks.rpc.mockResolvedValue({ data: { state }, error: null })
      expect((await runReportJob("owner", 7, "manual")).state).toBe(state)
    }
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it("stores a generated report only using the server-issued lease", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          state: "claimed",
          report_id: "a0000000-0000-4000-8000-000000000001",
          lease_token: "b0000000-0000-4000-8000-000000000001",
          snapshot: {},
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null })
    await expect(runReportJob("owner", 30, "manual")).resolves.toMatchObject({
      state: "ready",
    })
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "finish_learning_report",
      expect.objectContaining({
        p_lease_token: "b0000000-0000-4000-8000-000000000001",
        p_model_id: "configured-model",
        p_token_usage: { total_tokens: 24 },
      }),
    )
  })
  it("does not return a result that was rejected after consent revocation", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          state: "claimed",
          report_id: "a0000000-0000-4000-8000-000000000001",
          lease_token: "b0000000-0000-4000-8000-000000000001",
          snapshot: {},
        },
        error: null,
      })
      .mockResolvedValue({ data: false, error: null })
    await expect(runReportJob("owner", 7, "manual")).rejects.toMatchObject({
      status: 409,
    })
  })
  it("records sanitized provider errors without saving prompt or credentials", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: {
          state: "claimed",
          report_id: "a0000000-0000-4000-8000-000000000001",
          lease_token: "b0000000-0000-4000-8000-000000000001",
          snapshot: {},
        },
        error: null,
      })
      .mockResolvedValue({ data: true, error: null })
    mocks.generate.mockRejectedValue(new Error("secret provider payload"))
    await expect(runReportJob("owner", 7, "manual")).rejects.toMatchObject({
      status: 502,
    })
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "finish_learning_report",
      expect.objectContaining({
        p_error_code: "provider_unavailable",
        p_content: {},
      }),
    )
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(
      "secret provider payload",
    )
  })
})
