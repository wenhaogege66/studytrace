import { describe, expect, it } from "vitest"

import {
  areTaskStepsComplete,
  canStartTask,
  formatDuration,
  mapTask,
  parseTaskSteps,
  stepsToJson,
  taskStatusForOutcome,
} from "@/lib/domain"
import type { Tables } from "@/types/database"

describe("domain data conversions", () => {
  it("keeps valid task steps and drops malformed JSON entries", () => {
    const steps = parseTaskSteps([
      { id: "one", title: "  第一步  ", completed: true },
      null,
      "invalid",
      { title: "" },
      { id: "two", title: "第二步", completed: false },
    ])
    expect(steps).toEqual([
      { id: "one", title: "第一步", completed: true },
      { id: "two", title: "第二步", completed: false },
    ])
    expect(stepsToJson(steps)).toEqual(steps)
  })

  it("maps database task enums and step JSON into the product type", () => {
    const row: Tables<"tasks"> = {
      id: "task-1",
      user_id: "user-1",
      title: "测试任务",
      steps: [{ id: "step-1", title: "开始", completed: false }],
      priority: "high",
      estimated_minutes: 25,
      observation_profile: "study_paper_v1",
      status: "planned",
      completed_at: null,
      created_at: "2026-08-03T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
    }
    expect(mapTask(row)).toMatchObject({
      priority: "high",
      observation_profile: "study_paper_v1",
      status: "planned",
      steps: [{ title: "开始" }],
    })
  })

  it("formats timer values consistently", () => {
    expect(formatDuration(9)).toBe("00:09")
    expect(formatDuration(65)).toBe("01:05")
    expect(formatDuration(3_665)).toBe("01:01:05")
  })

  it("keeps task lifecycle independent from optional review state", () => {
    expect(taskStatusForOutcome("completed")).toBe("completed")
    expect(taskStatusForOutcome("partially_completed")).toBe("in_progress")
    expect(taskStatusForOutcome("not_completed")).toBe("in_progress")
    expect(canStartTask("planned")).toBe(true)
    expect(canStartTask("in_progress")).toBe(true)
    expect(canStartTask("completed")).toBe(false)
    expect(canStartTask("archived")).toBe(false)
  })

  it("only treats a non-empty list of completed steps as task completion", () => {
    expect(areTaskStepsComplete([])).toBe(false)
    expect(
      areTaskStepsComplete([
        { id: "one", title: "第一步", completed: true },
        { id: "two", title: "第二步", completed: false },
      ]),
    ).toBe(false)
    expect(
      areTaskStepsComplete([
        { id: "one", title: "第一步", completed: true },
        { id: "two", title: "第二步", completed: true },
      ]),
    ).toBe(true)
  })
})
