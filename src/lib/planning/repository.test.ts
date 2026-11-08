import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  rpc: vi.fn(),
  getSession: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }))
vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({ auth: { getSession: mocks.getSession } }),
}))

import { mapTask } from "@/lib/domain"
import { manualLearningPlan } from "@/lib/planning/manual"
import { planFromTask, saveLearningPlan } from "@/lib/planning/repository"

describe("adopted plan persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable")
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: "owner" },
          access_token: "original-identity-jwt",
        },
      },
    })
    mocks.createClient.mockReturnValue({ rpc: mocks.rpc })
  })
  it("freezes the original JWT for the atomic save rather than following an account switch", async () => {
    const plan = manualLearningPlan("复习函数")
    mocks.rpc.mockResolvedValue({
      data: {
        user_id: "owner",
        steps: plan.steps,
        priority: "medium",
        status: "planned",
        observation_profile: "study_paper_v1",
      },
      error: null,
    })
    await saveLearningPlan({
      userId: "owner",
      requestId: crypto.randomUUID(),
      plan,
      revisions: [],
    })
    const options = mocks.createClient.mock.calls[0][2]
    expect(await options.accessToken()).toBe("original-identity-jwt")
    mocks.getSession.mockResolvedValue({
      data: {
        session: { user: { id: "new-owner" }, access_token: "other-jwt" },
      },
    })
    expect(await options.accessToken()).toBe("original-identity-jwt")
  })
  it("does not write an old draft after an identity change", async () => {
    mocks.getSession.mockResolvedValue({
      data: {
        session: { user: { id: "new-owner" }, access_token: "other-jwt" },
      },
    })
    await expect(
      saveLearningPlan({
        userId: "owner",
        requestId: crypto.randomUUID(),
        plan: manualLearningPlan("复习函数"),
        revisions: [],
      }),
    ).rejects.toThrow("使用身份已改变")
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it("keeps current completion progress while restoring the actual adopted recommendation", () => {
    const adopted = {
      ...manualLearningPlan("复习函数"),
      method: "采用独立重做法",
      methodReason: "根据实际目标选择",
      context: { stage: "senior" },
    }
    const task = mapTask({
      id: "task",
      user_id: "owner",
      title: "函数复习",
      steps: adopted.steps.map((step, index) => ({
        ...step,
        completed: index === 0,
      })),
      priority: "high",
      status: "in_progress",
      observation_profile: "study_paper_v1",
      created_at: "2026-11-08T00:00:00Z",
      updated_at: "2026-11-08T00:00:00Z",
      completed_at: null,
      estimated_minutes: 50,
      planning_context: { stage: "senior" },
      method_summary: adopted.method,
    })
    const result = planFromTask(task, adopted)
    expect(result.methodReason).toBe(adopted.methodReason)
    expect(result.context).toEqual({ stage: "senior" })
    expect(result.steps[0].completed).toBe(true)
    expect(result.priority).toBe("high")
  })
})
