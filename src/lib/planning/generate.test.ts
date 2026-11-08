import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  createProvider: vi.fn(),
  model: vi.fn(),
}))
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: mocks.generateText,
}))
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createProvider,
}))

import {
  normalizePreparedPlan,
  prepareLearningPlan,
  reviewLearningPlan,
} from "@/lib/planning/generate"
import { manualLearningPlan } from "@/lib/planning/manual"

const input = {
  intent: "复习五道错题",
  answers: {},
  round: 0,
  forceGenerate: false,
}

describe("planning provider boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("QWEN_API_KEY", "test-only-not-a-real-key")
    vi.stubEnv("QWEN_PLANNING_ENABLED", "true")
    vi.stubEnv(
      "QWEN_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    mocks.createProvider.mockReturnValue({ chatModel: mocks.model })
  })
  it("normalizes generated IDs and binds the result to actual user intent", () => {
    const plan = manualLearningPlan("模型杜撰的原始意图")
    const result = normalizePreparedPlan({ kind: "plan", plan }, input)
    expect(result.kind).toBe("plan")
    if (result.kind === "plan") {
      expect(result.plan.intent).toBe(input.intent)
      expect(result.plan.steps[0].id).not.toBe(plan.steps[0].id)
      expect(result.plan.steps.every((step) => !step.completed)).toBe(true)
    }
  })
  it("rejects duplicate steps, too many visible questions and ignored skip", () => {
    const plan = manualLearningPlan(input.intent)
    expect(() =>
      normalizePreparedPlan(
        {
          kind: "plan",
          plan: {
            ...plan,
            steps: [plan.steps[0], plan.steps[0], plan.steps[2]],
          },
        },
        input,
      ),
    ).toThrow()
    const questions = Array.from({ length: 4 }, (_, index) => ({
      id: `q${index}`,
      prompt: "问题",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      dependsOn: null,
    }))
    expect(() =>
      normalizePreparedPlan(
        { kind: "questions", questions, explanation: "" },
        input,
      ),
    ).toThrow()
    expect(() =>
      normalizePreparedPlan(
        {
          kind: "questions",
          questions: questions.slice(0, 1),
          explanation: "",
        },
        { ...input, forceGenerate: true },
      ),
    ).toThrow("MODEL_IGNORED_GENERATION_REQUEST")
  })
  it("rejects unsafe provider hosts before making any network request", async () => {
    vi.stubEnv("QWEN_BASE_URL", "https://attacker.invalid/compatible-mode/v1")
    await expect(prepareLearningPlan(input)).rejects.toThrow(
      "QWEN_INVALID_BASE_URL",
    )
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
  it("defaults planning off until a rotated key and free quota are explicitly enabled", async () => {
    vi.stubEnv("QWEN_PLANNING_ENABLED", "false")
    await expect(prepareLearningPlan(input)).rejects.toThrow(
      "QWEN_PLANNING_DISABLED",
    )
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
  it("uses only the configured model, without a fallback request", async () => {
    vi.stubEnv("QWEN_PLANNING_MODEL", "configured-free-model")
    mocks.generateText.mockRejectedValue(new Error("free quota exhausted"))
    await expect(prepareLearningPlan(input)).rejects.toThrow(
      "free quota exhausted",
    )
    expect(mocks.model).toHaveBeenCalledWith("configured-free-model")
    expect(mocks.generateText).toHaveBeenCalledTimes(1)
  })
  it("uses the compatible provider-facing schema for prepare and review", async () => {
    const plan = manualLearningPlan(input.intent)
    mocks.generateText.mockResolvedValueOnce({ output: { kind: "plan", plan } })
    await prepareLearningPlan(input)
    const prepareFormat =
      await mocks.generateText.mock.calls[0][0].output.responseFormat
    expect(prepareFormat.type).toBe("json")
    expect(JSON.stringify(prepareFormat.schema)).not.toContain("propertyNames")
    mocks.generateText.mockResolvedValueOnce({
      output: { comment: "保留当前方案", reason: "", suggestion: null },
    })
    await reviewLearningPlan({ initial: plan, current: plan })
    const reviewFormat =
      await mocks.generateText.mock.calls[1][0].output.responseFormat
    expect(reviewFormat.type).toBe("json")
    expect(JSON.stringify(reviewFormat.schema)).not.toContain("propertyNames")
  })
  it("does not accept review suggestions that rewrite already completed steps", async () => {
    const initial = manualLearningPlan(input.intent)
    const current = {
      ...initial,
      steps: initial.steps.map((step, index) => ({
        ...step,
        completed: index === 0,
      })),
    }
    mocks.generateText.mockResolvedValue({
      output: {
        comment: "调整建议",
        reason: "",
        suggestion: {
          ...current,
          steps: current.steps.map((step, index) =>
            index === 0 ? { ...step, title: "改掉历史" } : step,
          ),
        },
      },
    })
    await expect(reviewLearningPlan({ initial, current })).rejects.toThrow(
      "COMPLETED_STEP_CHANGED",
    )
  })
})
