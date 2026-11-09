import { z } from "zod"

export const insightWindowValues = [7, 30] as const
export type InsightWindow = (typeof insightWindowValues)[number]

const nonnegativeNumber = z.coerce.number().finite().nonnegative()
// Keep null first: z.coerce.number() would otherwise turn null into 0 and make
// an empty evidence bucket look like a real 0/5 rating.
const nullableNonnegativeNumber = z.union([z.null(), nonnegativeNumber])

const distributionItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  count: nonnegativeNumber,
})

const timeBucketSchema = z.object({
  id: z.enum(["morning", "midday", "afternoon", "evening", "night"]),
  label: z.string(),
  segment_count: nonnegativeNumber,
  actual_seconds: nonnegativeNumber,
  reviewed_count: nonnegativeNumber,
  average_rating: nullableNonnegativeNumber,
  outcome_count: nonnegativeNumber,
  completion_percent: nullableNonnegativeNumber,
})

export const insightsReportSchema = z.object({
  enabled: z.boolean(),
  generated_at: z.string(),
  data_coverage: z.object({
    complete: z.boolean(),
    global_truncated: z.boolean(),
    period_complete: z.boolean(),
    recommendation_evidence_complete: z.boolean(),
    first_truncated_at: z.string().nullable(),
    last_truncated_at: z.string().nullable(),
    dropped_counts: z.record(z.string(), nonnegativeNumber),
  }),
  period: z.object({
    days: z.union([z.literal(7), z.literal(30)]),
    timezone: z.string().min(1),
    start_at: z.string(),
    end_at: z.string(),
  }),
  overview: z.object({
    active_days: nonnegativeNumber,
    completed_tasks: nonnegativeNumber,
    actual_seconds: nonnegativeNumber,
    reviewed_sessions: nonnegativeNumber,
    terminal_sessions: nonnegativeNumber,
    review_coverage_percent: nonnegativeNumber,
  }),
  segments: z.object({
    eligible_count: nonnegativeNumber,
    median_seconds: nonnegativeNumber,
    backfilled_count: nonnegativeNumber,
    distribution: z.array(distributionItemSchema),
  }),
  time_buckets: z.array(timeBucketSchema),
  observation: z.object({
    cloud: z
      .object({
        window_count: nonnegativeNumber,
        unknown_window_count: nonnegativeNumber,
        sampled_seconds: nonnegativeNumber,
        confirmed_event_count: nonnegativeNumber,
      })
      .optional(),
    observed_seconds: nonnegativeNumber,
    coverage_percent: nonnegativeNumber,
    confirmed_event_count: nonnegativeNumber,
    confirmed_events_per_hour: nonnegativeNumber,
    reminder_responses: z.object({
      none: nonnegativeNumber.default(0),
      dismissed: nonnegativeNumber.default(0),
      back_to_task: nonnegativeNumber.default(0),
      normal_activity: nonnegativeNumber.default(0),
      not_needed: nonnegativeNumber.default(0),
      later: nonnegativeNumber.default(0),
    }),
  }),
  precursor: z.object({
    evidence_window_days: z.literal(30),
    manual_marker_count: nonnegativeNumber,
    correlated_marker_count: nonnegativeNumber,
    correlated_percent: nonnegativeNumber,
  }),
  readiness: z.object({
    evidence_window_days: z.literal(30),
    evidence_eligible_segments: nonnegativeNumber,
    evidence_active_days: nonnegativeNumber,
    evidence_median_seconds: nonnegativeNumber,
    patterns_ready: z.boolean(),
    required_segments: nonnegativeNumber,
    required_active_days: nonnegativeNumber,
    precursor_ready: z.boolean(),
    required_manual_markers: nonnegativeNumber,
  }),
})

export type InsightsReport = z.infer<typeof insightsReportSchema>
export type InsightTimeBucket = InsightsReport["time_buckets"][number]

export type InsightSuggestion = {
  ready: boolean
  progressPercent: number
  title: string
  detail: string
  focusMinutes: number | null
  restMinutes: number | null
  bestTimeBucket: InsightTimeBucket | null
  precursorStatement: string | null
}

export function parseInsightsReport(value: unknown): InsightsReport {
  return insightsReportSchema.parse(value)
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function bestSupportedTimeBucket(report: InsightsReport) {
  const supported = report.time_buckets
    .filter(
      (bucket) => bucket.reviewed_count >= 2 && bucket.average_rating !== null,
    )
    .sort(
      (left, right) => (right.average_rating ?? 0) - (left.average_rating ?? 0),
    )

  if (supported.length < 2) return null
  const [best, runnerUp] = supported
  if (
    !best ||
    !runnerUp ||
    (best.average_rating ?? 0) <= (runnerUp.average_rating ?? 0)
  )
    return null
  return best
}

export function buildInsightSuggestion(
  report: InsightsReport,
): InsightSuggestion {
  const segmentProgress =
    report.readiness.evidence_eligible_segments /
    report.readiness.required_segments
  const dayProgress =
    report.readiness.evidence_active_days /
    report.readiness.required_active_days
  const progressPercent = Math.round(
    clamp(Math.min(segmentProgress, dayProgress) * 100, 0, 100),
  )

  const precursorStatement = report.readiness.precursor_ready
    ? `近 ${report.precursor.evidence_window_days} 天 ${report.precursor.manual_marker_count} 次主动标记中，有 ${report.precursor.correlated_marker_count} 次在此前 5 分钟出现了经你确认的画面变化（${Math.round(report.precursor.correlated_percent)}%）。这是共现记录，不代表因果或能力判断。`
    : null

  if (!report.data_coverage.recommendation_evidence_complete) {
    return {
      ready: false,
      progressPercent,
      title: "部分历史未被记录，暂不生成建议",
      detail:
        "事实记录曾达到安全容量上限。当前汇总仍可查看，但可能不完整，因此不会据此推荐工作—休息区间或高效时段。清理旧记录不会补回已经跳过的事实。",
      focusMinutes: null,
      restMinutes: null,
      bestTimeBucket: null,
      precursorStatement: null,
    }
  }

  if (!report.readiness.patterns_ready) {
    const missingSegments = Math.max(
      0,
      report.readiness.required_segments -
        report.readiness.evidence_eligible_segments,
    )
    const missingDays = Math.max(
      0,
      report.readiness.required_active_days -
        report.readiness.evidence_active_days,
    )
    return {
      ready: false,
      progressPercent,
      title: "先继续记录，不急着下结论",
      detail: `近 ${report.readiness.evidence_window_days} 天的证据池还需要至少 ${missingSegments} 个有效投入片段、${missingDays} 个活跃日。达到最低样本量后，StudyTrace 才会给出工作—休息区间和相对适合的时段。`,
      focusMinutes: null,
      restMinutes: null,
      bestTimeBucket: null,
      precursorStatement,
    }
  }

  const medianMinutes = Math.max(
    1,
    report.readiness.evidence_median_seconds / 60,
  )
  const focusMinutes = clamp(Math.round(medianMinutes / 5) * 5, 20, 50)
  const restMinutes = focusMinutes <= 30 ? 5 : focusMinutes <= 45 ? 8 : 10
  const bestTimeBucket = bestSupportedTimeBucket(report)
  const timeDetail = bestTimeBucket
    ? `在至少有 2 次复盘的时段中，${bestTimeBucket.label}当前平均自评最高（${bestTimeBucket.average_rating}/5，共 ${bestTimeBucket.reviewed_count} 次复盘）。`
    : "达到 2 次复盘的时段还不足两个，或当前最高自评并列，暂不比较时段。"

  return {
    ready: true,
    progressPercent: 100,
    title: `下一阶段可尝试 ${focusMinutes} + ${restMinutes} 分钟`,
    detail: `根据近 ${report.readiness.evidence_window_days} 天证据池中的连续投入时长中位数，可先尝试投入 ${focusMinutes} 分钟、离开任务休息 ${restMinutes} 分钟。${timeDetail} 这是一项可随复盘调整的实验建议。`,
    focusMinutes,
    restMinutes,
    bestTimeBucket,
    precursorStatement,
  }
}

export function formatEvidenceDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  if (safeSeconds === 0) return "0 分钟"
  if (safeSeconds < 60) return "不足 1 分钟"
  const totalMinutes = Math.floor(safeSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`
}

export function formatPercent(value: number) {
  return `${Math.round(clamp(value, 0, 100))}%`
}
