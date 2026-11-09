import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  configured: vi.fn(),
  job: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/supabase-service", () => ({
  getServiceSupabase: () => ({ rpc: mocks.rpc }),
}))
vi.mock("@/lib/reports/generator", () => ({
  reportProviderConfigured: mocks.configured,
}))
vi.mock("@/lib/reports/service", () => ({ runReportJob: mocks.job }))

import { GET } from "./route"

function request(authorization = "Bearer test-cron-secret") {
  return new Request("https://example.com/api/cron/reports", {
    headers: { authorization },
  })
}
describe("bounded automatic report scheduler", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("CRON_SECRET", "test-cron-secret")
    mocks.configured.mockReturnValue(true)
    mocks.job.mockResolvedValue({ state: "ready" })
  })
  afterEach(() => vi.unstubAllEnvs())
  it("rejects unauthorized and multibyte headers without throwing or touching data", async () => {
    expect((await GET(request("Bearer invalid"))).status).toBe(401)
    vi.stubEnv("CRON_SECRET", "ab")
    expect((await GET(request("Bearer éé"))).status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it("processes multiple small batches, excluding already visited users", async () => {
    const ids = Array.from(
      { length: 12 },
      (_, index) =>
        `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    )
    mocks.rpc.mockImplementation(
      async (
        _name: string,
        args: { p_limit: number; p_exclude: string[] },
      ) => ({
        data: ids
          .filter((id) => !args.p_exclude.includes(id))
          .slice(0, args.p_limit),
        error: null,
      }),
    )
    const response = await GET(request())
    expect(await response.json()).toMatchObject({
      processed: 12,
      states: { ready: 12 },
      deferred: false,
    })
    expect(mocks.job).toHaveBeenCalledTimes(12)
  })
  it("stops on quota instead of invoking a paid fallback", async () => {
    mocks.rpc.mockResolvedValue({
      data: ["a0000000-0000-4000-8000-000000000001"],
      error: null,
    })
    mocks.job.mockResolvedValue({ state: "quota" })
    expect(await (await GET(request())).json()).toMatchObject({
      processed: 1,
      deferred: true,
    })
    expect(mocks.job).toHaveBeenCalledTimes(1)
  })
})
