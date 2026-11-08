import { asSchema, generateText } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateText: vi.fn(actual.generateText) }
})

import { planningReviewSchema } from "@/lib/planning/contract"
import {
  prepareLearningPlan,
  reviewLearningPlan,
} from "@/lib/planning/generate"
import { manualLearningPlan } from "@/lib/planning/manual"

const input = {
  intent: "复习五道数学错题",
  answers: { scope: "错题" },
  round: 0,
  forceGenerate: false,
}

function completion(value: unknown) {
  return Response.json({
    id: "synthetic-completion",
    object: "chat.completion",
    created: 1_800_000_000,
    model: "qwen3.8-flash",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(value) },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  })
}

describe("planning envelope through the real AI SDK HTTP boundary", () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("QWEN_API_KEY", "test-only-not-a-real-key")
    vi.stubEnv(
      "QWEN_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    vi.stubEnv("QWEN_PLANNING_ENABLED", "true")
    vi.stubEnv("QWEN_PLANNING_MODEL", "qwen3.8-flash")
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("AI_SDK_LOG_WARNINGS", false)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it("sends JSON Object with the complete derived schema in system instructions and unwraps the validated response", async () => {
    const plan = manualLearningPlan("模型生成的意图")
    fetchMock.mockResolvedValue(
      completion({ response: { kind: "plan", plan } }),
    )
    const result = await prepareLearningPlan(input)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    )
    const body = JSON.parse(options?.body as string)
    expect(body.response_format).toEqual({ type: "json_object" })
    expect(body).not.toHaveProperty("json_schema")
    const schema = JSON.parse(body.messages[0].content.split("\n").at(-1))
    const outputFormat =
      await vi.mocked(generateText).mock.calls[0][0].output!.responseFormat
    expect(outputFormat).toMatchObject({ type: "json", schema })
    expect(schema).toMatchObject({
      type: "object",
      required: ["response"],
      additionalProperties: false,
    })
    expect(Object.keys(schema.properties)).toEqual(["response"])
    expect(schema.properties.response.oneOf).toHaveLength(2)
    expect(
      schema.properties.response.oneOf.map(
        (branch: { properties: { kind: { const: string } } }) =>
          branch.properties.kind.const,
      ),
    ).toEqual(["questions", "plan"])
    expect(JSON.stringify(schema)).toContain("propertyNames")
    expect(JSON.stringify(schema)).toContain("additionalItems")
    expect(body.messages[0].content).toContain("最外层只包含 response 字段")
    expect(body.max_tokens).toBe(2300)
    expect(body.enable_thinking).toBe(false)
    expect(result).not.toHaveProperty("response")
    expect(result).toMatchObject({
      kind: "plan",
      plan: { intent: input.intent, context: input.answers },
    })
  })

  it("uses JSON Object and the complete review schema while preserving application validation", async () => {
    const plan = manualLearningPlan(input.intent)
    const review = { comment: "保留当前方案", reason: "", suggestion: null }
    fetchMock.mockResolvedValue(completion(review))
    await expect(
      reviewLearningPlan({ initial: plan, current: plan }),
    ).resolves.toEqual(review)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.response_format).toEqual({ type: "json_object" })
    expect(body.messages[0].content).toContain(
      JSON.stringify(await asSchema(planningReviewSchema).jsonSchema),
    )
    expect(body.messages[0].content).toContain("JSON 对象")
    expect(body.max_tokens).toBe(2400)
    expect(body.enable_thinking).toBe(false)
  })

  it("rejects an invalid review suggestion using the original Zod validator", async () => {
    const plan = manualLearningPlan(input.intent)
    fetchMock.mockResolvedValue(
      completion({
        comment: "调整建议",
        reason: "",
        suggestion: { ...plan, context: { ["x".repeat(41)]: "范围" } },
      }),
    )
    await expect(
      reviewLearningPlan({ initial: plan, current: plan }),
    ).rejects.toThrow("No object generated")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      "missing envelope",
      { kind: "plan", plan: manualLearningPlan(input.intent) },
    ],
    ["invalid response discriminator", { response: { kind: "other" } }],
    [
      "wrong tuple length",
      {
        response: {
          kind: "plan",
          plan: {
            ...manualLearningPlan(input.intent),
            completionCriteria: ["只有一项"],
          },
        },
      },
    ],
    [
      "invalid record key",
      {
        response: {
          kind: "plan",
          plan: {
            ...manualLearningPlan(input.intent),
            context: { ["x".repeat(41)]: "范围" },
          },
        },
      },
    ],
  ])(
    "rejects %s instead of weakening output validation",
    async (_label, value) => {
      fetchMock.mockResolvedValue(completion(value))
      await expect(prepareLearningPlan(input)).rejects.toThrow(
        "No object generated",
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
})
