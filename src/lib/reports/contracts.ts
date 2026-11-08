import { z } from "zod"

import {
  insightsReportSchema,
  type InsightsReport,
} from "@/lib/insights/insights"

const shortText = z.string().trim().min(1).max(600)
const citationSchema = z.array(z.string().max(60)).min(1).max(5)

export const learningReportContentSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: shortText,
  conclusions: z
    .array(
      z.object({
        statement: shortText,
        evidence: citationSchema,
        limitation: shortText,
      }),
    )
    .min(1)
    .max(4),
  encouragement: z.object({ text: shortText, evidence: citationSchema }),
  experiments: z
    .array(
      z.object({
        action: shortText,
        reason: shortText,
        evidence: citationSchema,
      }),
    )
    .min(1)
    .max(3),
  limitations: z.array(shortText).min(1).max(5),
})
export type LearningReportContent = z.infer<typeof learningReportContentSchema>

export const reportSnapshotSchema = z.object({
  version: z.literal(1),
  facts: insightsReportSchema,
  adopted_plans: z
    .array(
      z.object({
        purpose: z.string().max(250),
        criterion: z.string().max(250),
        method: z.string().max(400),
        estimated_minutes: z.number().nonnegative(),
        status: z.string(),
        completed_steps: z.number().nonnegative(),
        step_count: z.number().nonnegative(),
      }),
    )
    .max(10),
  adjustments: z
    .array(z.object({ kind: z.string(), changes: z.unknown() }))
    .max(5),
  estimate_summary: z.object({
    completed_plan_count: z.number().nonnegative(),
    estimated_minutes: z.number().nonnegative(),
    actual_seconds: z.number().nonnegative(),
  }),
  obstacles: z
    .array(
      z.object({
        reason: z.string().max(120),
        count: z.number().nonnegative(),
      }),
    )
    .max(5),
})
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>
export type ReportEvidence = {
  id: string
  label: string
  value: string
  samples: number
}

export function buildReportEvidence(
  snapshot: ReportSnapshot,
): ReportEvidence[] {
  const f = snapshot.facts
  const evidence: ReportEvidence[] = [
    {
      id: "activity",
      label: "活跃天数",
      value: `${f.overview.active_days} 天 / ${f.period.days} 天`,
      samples: f.overview.active_days,
    },
    {
      id: "completion",
      label: "完成计划",
      value: `${f.overview.completed_tasks} 个`,
      samples: f.overview.completed_tasks,
    },
    {
      id: "time",
      label: "实际投入",
      value: `${f.overview.actual_seconds} 秒；${f.segments.eligible_count} 个有效片段；中位数 ${f.segments.median_seconds} 秒`,
      samples: f.segments.eligible_count,
    },
    {
      id: "review",
      label: "学习复盘",
      value: `${f.overview.reviewed_sessions}/${f.overview.terminal_sessions} 次，覆盖 ${f.overview.review_coverage_percent}%`,
      samples: f.overview.terminal_sessions,
    },
    {
      id: "observation",
      label: "过程观察",
      value: `有效覆盖 ${f.observation.observed_seconds} 秒，经用户确认 ${f.observation.confirmed_event_count} 次；未确认线索不在统计中`,
      samples: f.observation.confirmed_event_count,
    },
    {
      id: "readiness",
      label: "规律证据",
      value: `近30天 ${f.readiness.evidence_eligible_segments}/20 个片段，${f.readiness.evidence_active_days}/10 个活跃日；完整性 ${f.data_coverage.recommendation_evidence_complete ? "完整" : "存在截断"}`,
      samples: f.readiness.evidence_eligible_segments,
    },
    {
      id: "estimate",
      label: "已完成计划预计与实际",
      value: `${snapshot.estimate_summary.completed_plan_count} 个计划：预计 ${snapshot.estimate_summary.estimated_minutes} 分钟，实际 ${snapshot.estimate_summary.actual_seconds} 秒`,
      samples: snapshot.estimate_summary.completed_plan_count,
    },
  ]
  for (const [index, plan] of snapshot.adopted_plans.entries())
    evidence.push({
      id: `plan_${index + 1}`,
      label: `采用方案 ${index + 1}`,
      value: `目的：${plan.purpose || "未填写"}；方法：${plan.method || "未填写"}；完成标准：${plan.criterion || "未填写"}；步骤 ${plan.completed_steps}/${plan.step_count}`,
      samples: 1,
    })
  for (const [index, change] of snapshot.adjustments.entries())
    evidence.push({
      id: `change_${index + 1}`,
      label: `方案修订 ${index + 1}`,
      value: JSON.stringify(change).slice(0, 1200),
      samples: 1,
    })
  for (const [index, obstacle] of snapshot.obstacles.entries())
    evidence.push({
      id: `obstacle_${index + 1}`,
      label: "主动记录的阻碍",
      value: `${obstacle.reason}：${obstacle.count} 次`,
      samples: obstacle.count,
    })
  for (const bucket of f.time_buckets)
    evidence.push({
      id: `time_${bucket.id}`,
      label: bucket.label,
      value: `${bucket.segment_count} 个片段，${bucket.reviewed_count} 次自评，平均自评 ${bucket.average_rating ?? "暂无"}/5，完成结果 ${bucket.outcome_count} 次`,
      samples: bucket.reviewed_count,
    })
  return evidence
}

export function canDiscussPatterns(facts: InsightsReport) {
  return (
    facts.data_coverage.recommendation_evidence_complete &&
    facts.readiness.patterns_ready &&
    facts.readiness.evidence_eligible_segments >= 20 &&
    facts.readiness.evidence_active_days >= 10
  )
}

export function validateReportCitations(
  content: LearningReportContent,
  evidence: ReportEvidence[],
) {
  const available = new Set(evidence.map((item) => item.id))
  const references = [
    ...content.conclusions.flatMap((item) => item.evidence),
    ...content.encouragement.evidence,
    ...content.experiments.flatMap((item) => item.evidence),
  ]
  if (references.some((id) => !available.has(id)))
    throw new Error("REPORT_UNKNOWN_EVIDENCE")
  for (const item of [
    ...content.conclusions.map((row) => ({
      text: row.statement,
      evidence: row.evidence,
    })),
    content.encouragement,
  ]) {
    const cited = evidence.filter((row) => item.evidence.includes(row.id))
    const allowed = new Set(
      cited.flatMap((row) =>
        [...row.value.matchAll(/\d+(?:\.\d+)?/g)].map((match) =>
          Number(match[0]),
        ),
      ),
    )
    for (const match of item.text.matchAll(/\d+(?:\.\d+)?/g)) {
      if (!allowed.has(Number(match[0])))
        throw new Error("REPORT_UNSUPPORTED_NUMBER")
    }
  }
  return content
}
