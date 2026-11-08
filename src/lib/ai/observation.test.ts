import { asSchema, generateText } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateText: vi.fn(actual.generateText) }
})

import { analyzeObservation } from "@/lib/ai/observation"
import type { ObservationAgreement } from "@/lib/vision/agreement"
import {
  cloudResultSchema,
  type CloudRequest,
} from "@/lib/vision/cloud-contract"

const agreement: ObservationAgreement = {
  phone: "restricted",
  tablet: "allowed",
  absenceSeconds: 60,
  screenDirection: false,
}
const input: CloudRequest = {
  sessionId: "c3c597cc-7186-4f01-9b48-43ec2b9bd35a",
  windowId: "0900a032-1481-4143-afd5-631531f211e5",
  frames: [0, 2, 4, 6].map((seconds, index) => ({
    capturedAt: new Date(1_800_000_000_000 + seconds * 1_000).toISOString(),
    image: `data:image/jpeg;base64,${btoa(`synthetic-frame-${index}`)}`,
  })),
}
const validResult = {
  quality: "good",
  phone: "possible",
  tablet: "unknown",
}

function completion(content: string) {
  return Response.json({
    id: "synthetic-completion",
    object: "chat.completion",
    created: 1_800_000_000,
    model: "qwen3.8-flash",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: { prompt_tokens: 123, completion_tokens: 9, total_tokens: 132 },
  })
}

describe("Qwen multimodal JSON Object boundary", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("QWEN_API_KEY", "test-only-not-a-real-key")
    vi.stubEnv(
      "QWEN_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    vi.stubEnv("QWEN_VISION_MODEL", "qwen3.8-flash")
    vi.stubEnv("QWEN_VISION_ENABLED", "true")
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("AI_SDK_LOG_WARNINGS", false)
    fetchMock.mockResolvedValue(completion(JSON.stringify(validResult)))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it("sends json_object with the complete derived schema and four ordered frames", async () => {
    const signal = new AbortController().signal
    const result = await analyzeObservation(input, agreement, signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    )
    const body = JSON.parse(options?.body as string)
    expect(body.response_format).toEqual({ type: "json_object" })
    expect(body).not.toHaveProperty("json_schema")
    const jsonSchema = await asSchema(cloudResultSchema).jsonSchema
    expect(body.messages[0]).toEqual({
      role: "system",
      content: expect.stringContaining(JSON.stringify(jsonSchema)),
    })
    expect(body.messages[0].content).toContain("JSON 对象")
    expect(body.messages[0].content).toContain(
      '"phone":"restricted","tablet":"allowed"',
    )
    expect(body.messages[0].content).toContain("其他情况 unknown")
    const imageParts = body.messages[1].content.filter(
      (part: { type: string }) => part.type === "image_url",
    )
    expect(
      imageParts.map(
        (part: { image_url: { url: string } }) => part.image_url.url,
      ),
    ).toEqual(input.frames.map((frame) => frame.image))
    expect(body.model).toBe("qwen3.8-flash")
    expect(body.max_tokens).toBe(180)
    expect(body.temperature).toBe(0)
    expect(body.enable_thinking).toBe(false)
    const call = vi.mocked(generateText).mock.calls[0][0]
    expect(call).toMatchObject({
      maxRetries: 0,
      timeout: 12_000,
      abortSignal: signal,
      experimental_telemetry: { isEnabled: false },
    })
    expect(result).toEqual({
      result: validResult,
      model: "qwen3.8-flash",
      usage: { inputTokens: 123, outputTokens: 9 },
    })
    expect(result).not.toHaveProperty("frames")
  })

  it.each([
    ["unknown enum", JSON.stringify({ ...validResult, quality: "focused" })],
    ["missing field", JSON.stringify({ quality: "good", phone: "possible" })],
    ["wrong type", JSON.stringify({ ...validResult, tablet: true })],
    ["non-JSON output", "The learner is using a phone."],
  ])(
    "rejects %s instead of weakening Zod validation or retrying",
    async (_label, content) => {
      fetchMock.mockResolvedValueOnce(completion(content))
      await expect(
        analyzeObservation(input, agreement, new AbortController().signal),
      ).rejects.toThrow("No object generated")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it("does not fall back to another model or retry a provider failure", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            message: "synthetic free quota exhausted",
            type: "quota_exceeded",
          },
        },
        { status: 429 },
      ),
    )
    await expect(
      analyzeObservation(input, agreement, new AbortController().signal),
    ).rejects.toThrow("synthetic free quota exhausted")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).model).toBe(
      "qwen3.8-flash",
    )
  })

  it("propagates a stopped observation to the in-flight provider request", async () => {
    fetchMock.mockImplementationOnce(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const pending = analyzeObservation(input, agreement, controller.signal)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort(new Error("OBSERVATION_STOPPED"))
    await expect(pending).rejects.toThrow("OBSERVATION_STOPPED")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("never calls the provider without explicit deployment opt-in", async () => {
    vi.stubEnv("QWEN_VISION_ENABLED", "false")
    await expect(
      analyzeObservation(input, agreement, new AbortController().signal),
    ).rejects.toThrow("VISION_NOT_CONFIGURED")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
