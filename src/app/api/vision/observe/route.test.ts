import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  invalidImages,
  jpegImage,
  pngImage,
} from "@/test/vision-image-fixtures"

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUser: vi.fn(),
  rpc: vi.fn(),
  generate: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }))
vi.mock("@/lib/ai/vision-observation", () => ({
  generateVisualObservation: mocks.generate,
}))

import { POST } from "./route"

const sessionId = "00000000-0000-4000-8000-000000000001"
const consentToken = "00000000-0000-4000-8000-000000000002"
const requestId = "00000000-0000-4000-8000-000000000003"
const input = {
  sessionId,
  consentToken,
  image: jpegImage,
}
const observation = {
  signal: "unknown",
  taskRelevance: "uncertain",
  summary: "Cannot tell",
}
const context = {
  request_id: requestId,
  title: "Owned title",
  steps: [{ id: "one", title: "Read", completed: false }],
  observation_profile: "study_paper_v1",
}
const event = {
  id: "event",
  event_type: "visual_observation",
  source: "cloud_vision",
  visual_observation: observation,
}
function request(body: unknown = input, token = "Bearer test-jwt") {
  return new Request("http://localhost/api/vision/observe", {
    method: "POST",
    headers: { Authorization: token },
    body: JSON.stringify(body),
  })
}

describe("POST /api/vision/observe", () => {
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
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "reserve_vision_observation" ? [context] : event,
      error: null,
    }))
    mocks.generate.mockResolvedValue(observation)
  })
  afterEach(() => vi.unstubAllEnvs())

  it("blocks missing auth before provider and quota", async () => {
    expect((await POST(request(input, ""))).status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it("blocks invalid image before quota or provider", async () => {
    expect(
      (
        await POST(
          request({ ...input, image: "data:image/png;base64,/9j/2Q==" }),
        )
      ).status,
    ).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it.each(invalidImages)(
    "blocks $name before quota and provider",
    async ({ image }) => {
      const response = await POST(request({ ...input, image }))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "VISION_INVALID_REQUEST" })
      expect(mocks.rpc).not.toHaveBeenCalled()
      expect(mocks.generate).not.toHaveBeenCalled()
    },
  )
  it.each([jpegImage, pngImage])("accepts a genuine image", async (image) => {
    expect((await POST(request({ ...input, image }))).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.generate).toHaveBeenCalledTimes(1)
  })
  it.each(["42501", "P0002", "P0001"])(
    "blocks unauthorized, foreign, or off-device sessions (%s) before provider",
    async (code) => {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code, message: "private database detail" },
      })
      const response = await POST(request())
      expect(response.status).toBe(
        code === "P0002" ? 404 : code === "42501" ? 403 : 409,
      )
      expect(await response.text()).not.toContain("private")
      expect(mocks.generate).not.toHaveBeenCalled()
    },
  )
  it("skips provider when quota is exhausted", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null })
    expect((await POST(request())).status).toBe(429)
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it("derives context from reservation and saves one structured result", async () => {
    const response = await POST(
      request({ ...input, title: "Client injection" }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({
      event: { ...event, visual_observation: observation },
    })
    expect(mocks.generate).toHaveBeenCalledWith(
      {
        image: input.image,
        title: "Owned title",
        steps: context.steps,
        observationProfile: "study_paper_v1",
      },
      expect.any(AbortSignal),
    )
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "reserve_vision_observation", {
      p_session_id: sessionId,
      p_consent_token: consentToken,
    })
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "save_vision_observation", {
      p_session_id: sessionId,
      p_consent_token: consentToken,
      p_request_id: requestId,
      p_observation: observation,
    })
  })
  it.each(["revoked", "paused"])(
    "does not return an event when a %s result is rejected by save",
    async () => {
      mocks.rpc
        .mockResolvedValueOnce({ data: [context], error: null })
        .mockResolvedValueOnce({
          data: null,
          error: { code: "P0001", message: "late" },
        })
      const response = await POST(request())
      expect(response.status).toBe(409)
      expect(await response.json()).not.toHaveProperty("event")
    },
  )
  it("sanitizes timeout errors and never invokes save", async () => {
    mocks.generate.mockRejectedValue(
      Object.assign(new Error("raw model and credentials"), {
        name: "TimeoutError",
      }),
    )
    const response = await POST(request())
    expect(response.status).toBe(504)
    expect(await response.text()).not.toMatch(/raw|credentials/)
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it("rejects oversized streams without Content-Length before provider", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { Authorization: "Bearer test-jwt" },
        body,
        duplex: "half",
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
