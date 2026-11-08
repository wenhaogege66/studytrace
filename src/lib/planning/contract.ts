import { z } from "zod"

import { observationAgreementSchema } from "@/lib/vision/agreement"
import { observationProfileValues } from "@/lib/vision/profiles"

const shortText = z.string().trim().min(1).max(120)
export const planningQuestionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  prompt: shortText,
  options: z
    .array(z.object({ value: shortText, label: shortText }))
    .min(2)
    .max(8),
  dependsOn: z.object({ questionId: shortText, value: shortText }).nullable(),
})
export type PlanningQuestion = z.infer<typeof planningQuestionSchema>

export const learningPlanSchema = z.object({
  title: shortText,
  intent: z.string().trim().min(1).max(500),
  purpose: z.string().trim().max(300),
  purposeOptions: z.array(shortText).max(4),
  context: z.record(z.string().max(40), z.string().max(300)),
  method: z.string().trim().min(1).max(500),
  methodReason: z.string().trim().max(300),
  completionCriteria: z.tuple([shortText, shortText, shortText]),
  selectedCriterion: z.string().trim().min(1).max(300),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        title: shortText,
        completed: z.boolean(),
      }),
    )
    .min(1)
    .max(20),
  priority: z.enum(["low", "medium", "high"]),
  estimatedMinutes: z.number().int().min(1).max(480),
  sessionMinutes: z.number().int().min(1).max(180),
  observationProfile: z.enum(observationProfileValues),
  observationAgreement: observationAgreementSchema,
  dueAt: z.string().datetime({ offset: true }).nullable(),
})
export type LearningPlan = z.infer<typeof learningPlanSchema>

export const preparePlanningSchema = z.object({
  intent: z.string().trim().min(1).max(500),
  availableMinutes: z.number().int().min(1).max(180).optional(),
  answers: z
    .record(z.string().max(40), z.string().max(300))
    .refine((value) => Object.keys(value).length <= 12),
  round: z.number().int().min(0).max(2),
  forceGenerate: z.boolean().default(false),
})
export type PreparePlanningInput = z.infer<typeof preparePlanningSchema>

export const preparePlanningResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("questions"),
    questions: z.array(planningQuestionSchema).min(1).max(12),
    explanation: z.string().max(300),
  }),
  z.object({ kind: z.literal("plan"), plan: learningPlanSchema }),
])
export type PreparePlanningResponse = z.infer<
  typeof preparePlanningResponseSchema
>
export const planningReviewRequestSchema = z.object({
  initial: learningPlanSchema,
  current: learningPlanSchema,
  reason: z.string().trim().max(300).optional(),
})
export const planningReviewSchema = z.object({
  comment: z.string().trim().min(1).max(600),
  reason: z.string().trim().max(400),
  suggestion: learningPlanSchema.nullable(),
})
export type PlanningReview = z.infer<typeof planningReviewSchema>

export type PlanChange = { field: string; before: unknown; after: unknown }
export type PlanRevisionInput = {
  kind: "ai_initial" | "user_edit" | "ai_review" | "adopted" | "manual"
  snapshot: LearningPlan
  changes: PlanChange[]
  comment?: string
}

export function planChanges(
  before: LearningPlan,
  after: LearningPlan,
): PlanChange[] {
  return (Object.keys(after) as (keyof LearningPlan)[])
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ field: key, before: before[key], after: after[key] }))
}

export function visibleQuestions(
  questions: PlanningQuestion[],
  answers: Record<string, string>,
) {
  return questions.filter(
    (question) =>
      !question.dependsOn ||
      answers[question.dependsOn.questionId] === question.dependsOn.value,
  )
}

export function setPlanningAnswer(
  questions: PlanningQuestion[],
  answers: Record<string, string>,
  id: string,
  value: string,
) {
  const result = { ...answers, [id]: value }
  for (let pass = 0; pass < questions.length; pass++) {
    for (const question of questions) {
      if (
        question.dependsOn &&
        result[question.dependsOn.questionId] !== question.dependsOn.value
      )
        delete result[question.id]
    }
  }
  return result
}

export function validateQuestionTree(questions: PlanningQuestion[]) {
  const ids = new Set(questions.map((question) => question.id))
  if (ids.size !== questions.length) throw new Error("澄清问题重复")
  for (const question of questions) {
    if (
      new Set(question.options.map((option) => option.value)).size !==
      question.options.length
    )
      throw new Error("澄清选项重复")
    const visited = new Set([question.id])
    let dependency = question.dependsOn
    while (dependency) {
      if (!ids.has(dependency.questionId) || visited.has(dependency.questionId))
        throw new Error("澄清问题依赖无效")
      visited.add(dependency.questionId)
      const parent = questions.find(
        (item) => item.id === dependency?.questionId,
      )!
      if (!parent.options.some((option) => option.value === dependency?.value))
        throw new Error("澄清选项依赖无效")
      dependency = parent.dependsOn
    }
  }
  const branchSize = (question: PlanningQuestion): number =>
    1 +
    Math.max(
      0,
      ...question.options.map((option) =>
        questions
          .filter(
            (candidate) =>
              candidate.dependsOn?.questionId === question.id &&
              candidate.dependsOn.value === option.value,
          )
          .reduce((total, candidate) => total + branchSize(candidate), 0),
      ),
    )
  if (
    questions
      .filter((question) => !question.dependsOn)
      .reduce((total, question) => total + branchSize(question), 0) > 3
  )
    throw new Error("同组最多三个问题")
  return questions
}

export function needsFirstReview(
  initial: LearningPlan,
  current: LearningPlan,
  reviewUsed: boolean,
) {
  return !reviewUsed && planChanges(initial, current).length > 0
}

export const planningTemplates = [
  {
    id: "recall",
    label: "背诵",
    intent: "用 25 分钟复习并自测今天的 20 个英语单词",
  },
  {
    id: "mistakes",
    label: "错题复习",
    intent: "复习最近五道数学错题，找出错误原因并独立重做",
  },
  {
    id: "concept",
    label: "概念理解",
    intent: "理解一个目前不清楚的概念，并用自己的话解释和举例",
  },
] as const
