// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidImages, jpegImage } from "@/test/vision-image-fixtures"

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  chatModel: vi.fn(),
  create: vi.fn(),
}))
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: mocks.generateText,
}))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.create,
}))

import { generateVisualObservation } from "./vision-observation"

const input = {
  image: jpegImage,
  title: "Read algebra",
  steps: [{ id: "one", title: "Read chapter", completed: false }],
  observationProfile: "study_paper_v1" as const,
}

describe("trusted multimodal provider", () => {
  beforeEach(() => {
    vi.stubEnv("QWEN_API_KEY", "test-only-key")
    vi.stubEnv(
      "QWEN_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    vi.stubEnv("QWEN_VISION_MODEL", undefined)
    vi.clearAllMocks()
    mocks.create.mockReturnValue({ chatModel: mocks.chatModel })
    mocks.generateText.mockResolvedValue({
      output: {
        signal: "unknown",
        taskRelevance: "uncertain",
        summary: "  Cannot tell  ",
      },
    })
  })
  afterEach(() => vi.unstubAllEnvs())

  it("sends image and owned task context with the separate default model and a 12s timeout", async () => {
    await expect(generateVisualObservation(input)).resolves.toEqual({
      signal: "unknown",
      taskRelevance: "uncertain",
      summary: "Cannot tell",
    })
    expect(mocks.chatModel).toHaveBeenCalledWith("qwen3-vl-plus")
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining("简体中文"),
        timeout: 12000,
        maxRetries: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: expect.stringContaining("Read algebra") },
              {
                type: "image",
                image: expect.any(Uint8Array),
                mediaType: "image/jpeg",
              },
            ],
          },
        ],
      }),
    )
  })
  it("rejects an untrusted endpoint before making a model call", async () => {
    vi.stubEnv("QWEN_BASE_URL", "https://example.com/compatible-mode/v1")
    await expect(generateVisualObservation(input)).rejects.toThrow(
      "QWEN_INVALID_BASE_URL",
    )
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
  it("rejects off-device context without sending an image", async () => {
    await expect(
      generateVisualObservation({
        ...input,
        observationProfile: "off_device_v1",
      }),
    ).rejects.toThrow()
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
  it.each(invalidImages)("rejects $name before provider", async ({ image }) => {
    await expect(
      generateVisualObservation({ ...input, image }),
    ).rejects.toThrow("VISION_INVALID_IMAGE")
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
  it("validates the provider output instead of returning raw model data", async () => {
    mocks.generateText.mockResolvedValue({
      output: { signal: "focused", raw: "private" },
    })
    await expect(generateVisualObservation(input)).rejects.toThrow()
  })
})
