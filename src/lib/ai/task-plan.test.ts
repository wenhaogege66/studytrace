import { describe, expect, it } from "vitest"

import { taskPlanRequestSchema } from "@/lib/ai/task-plan-contract"
import { normalizeTaskPlan, validateQwenBaseURL } from "@/lib/ai/task-plan"

describe("task plan generation boundary", () => {
  it("rejects empty and oversized task titles", () => {
    expect(taskPlanRequestSchema.safeParse({ title: "   " }).success).toBe(
      false,
    )
    expect(
      taskPlanRequestSchema.safeParse({ title: "a".repeat(121) }).success,
    ).toBe(false)
  })

  it("normalizes exactly three ordered steps", () => {
    expect(
      normalizeTaskPlan({
        step1: "1. 明确复习范围",
        step2: "2、完成核心练习",
        step3: "3）核对并记录错因",
        priority: "medium",
        estimatedMinutes: 45,
        observationProfile: "study_paper_v1",
        profileReason: "需要持续阅读和纸笔书写",
      }),
    ).toMatchObject({
      steps: ["明确复习范围", "完成核心练习", "核对并记录错因"],
      observationProfile: "study_paper_v1",
    })
  })

  it("rejects duplicate model steps", () => {
    expect(() =>
      normalizeTaskPlan({
        step1: "开始",
        step2: "开始",
        step3: "检查",
        priority: "low",
        estimatedMinutes: 20,
        observationProfile: "off_device_v1",
        profileReason: "离开设备完成",
      }),
    ).toThrow("三个有效且不同的步骤")
  })

  it("only sends the API key to trusted Qwen HTTPS endpoints", () => {
    expect(
      validateQwenBaseURL(
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
      ),
    ).toBe("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")
    expect(() =>
      validateQwenBaseURL("https://example.com/compatible-mode/v1"),
    ).toThrow("QWEN_INVALID_BASE_URL")
    expect(() =>
      validateQwenBaseURL(
        "http://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      ),
    ).toThrow("QWEN_INVALID_BASE_URL")
  })
})
