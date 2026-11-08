import { agreementForProfile } from "@/lib/vision/agreement"
import type { LearningPlan } from "@/lib/planning/contract"

export function manualLearningPlan(
  intent: string,
  minutes = 25,
  context: Record<string, string> = {},
): LearningPlan {
  const title = intent.trim().slice(0, 120) || "我的学习计划"
  const safeMinutes = Number.isFinite(minutes)
    ? Math.max(1, Math.min(480, Math.round(minutes)))
    : 25
  const criteria: [string, string, string] = [
    "完成所列步骤，并记录一个收获",
    "能用自己的话说明本次所学",
    "完成一次不看答案的自测",
  ]
  return {
    title,
    intent: intent.trim() || title,
    purpose: "",
    purposeOptions: ["应对测验", "补齐不理解的地方", "巩固已有知识"],
    context,
    method: "先明确范围，再实践，最后检查",
    methodReason: "手动起步模板，请按实际材料修改。",
    completionCriteria: criteria,
    selectedCriterion: criteria[0],
    steps: [
      "明确本次学习范围和要解决的问题",
      "围绕范围练习或回忆，记录卡住的地方",
      "不看材料检查掌握情况，写下下一步",
    ].map((step) => ({
      id: crypto.randomUUID(),
      title: step,
      completed: false,
    })),
    priority: "medium",
    estimatedMinutes: safeMinutes,
    sessionMinutes: Math.min(safeMinutes, 25),
    observationProfile: "study_paper_v1",
    observationAgreement: agreementForProfile("study_paper_v1"),
    dueAt: null,
  }
}
