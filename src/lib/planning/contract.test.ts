import { describe, expect, it } from "vitest"

import {
  needsFirstReview,
  setPlanningAnswer,
  validateQuestionTree,
  visibleQuestions,
  type PlanningQuestion,
} from "@/lib/planning/contract"
import { manualLearningPlan } from "@/lib/planning/manual"

const questions: PlanningQuestion[] = [
  {
    id: "stage",
    prompt: "学段",
    options: [
      { value: "junior", label: "初中" },
      { value: "senior", label: "高中" },
    ],
    dependsOn: null,
  },
  {
    id: "grade",
    prompt: "年级",
    options: [
      { value: "one", label: "高一" },
      { value: "two", label: "高二" },
    ],
    dependsOn: { questionId: "stage", value: "senior" },
  },
  {
    id: "unit",
    prompt: "范围",
    options: [
      { value: "function", label: "函数" },
      { value: "equation", label: "方程" },
    ],
    dependsOn: { questionId: "grade", value: "one" },
  },
]

describe("guided planning decisions", () => {
  it("hides and clears dependent answers when the upstream choice changes", () => {
    const answers = setPlanningAnswer(
      questions,
      { stage: "senior", grade: "one", unit: "function" },
      "stage",
      "junior",
    )
    expect(answers).toEqual({ stage: "junior" })
    expect(visibleQuestions(questions, answers).map((item) => item.id)).toEqual(
      ["stage"],
    )
  })
  it("rejects cycles and references to unavailable choices", () => {
    expect(() =>
      validateQuestionTree([
        { ...questions[0], dependsOn: { questionId: "grade", value: "one" } },
        questions[1],
      ]),
    ).toThrow()
    expect(() =>
      validateQuestionTree([
        questions[0],
        {
          ...questions[1],
          dependsOn: { questionId: "stage", value: "missing" },
        },
      ]),
    ).toThrow()
  })
  it("reviews only the first actual edit, not an unchanged plan or later changes", () => {
    const initial = manualLearningPlan("复习五道错题")
    const current = { ...initial, sessionMinutes: 15 }
    expect(needsFirstReview(initial, initial, false)).toBe(false)
    expect(needsFirstReview(initial, current, false)).toBe(true)
    expect(needsFirstReview(initial, current, true)).toBe(false)
  })
})
