"use client"

import {
  Activity,
  CalendarDays,
  Camera,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MapPin,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  buildInsightSuggestion,
  formatEvidenceDuration,
  formatPercent,
  type InsightWindow,
  type InsightsReport,
} from "@/lib/insights/insights"
import {
  useInsights,
  useInsightsPreferencesMutation,
} from "@/lib/insights/use-insights"

const windows: { value: InsightWindow; label: string }[] = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
]

const reminderResponseLabels = [
  ["back_to_task", "已回到任务"],
  ["normal_activity", "当时在正常操作"],
  ["not_needed", "不需要提醒"],
  ["later", "稍后处理"],
  ["dismissed", "直接关闭"],
] as const

function Loading() {
  return (
    <div className="space-y-7" aria-label="正在读取长期记录">
      <Skeleton className="h-16 w-96 max-w-full" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof Clock3
  label: string
  value: string
  note: string
}) {
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Icon className="size-4 text-indigo-600" />
        {label}
      </div>
      <p className="mt-2 truncate text-2xl font-semibold tracking-tight text-slate-950 tabular-nums">
        {value}
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{note}</p>
    </div>
  )
}

function DurationEvidence({ report }: { report: InsightsReport }) {
  const maximum = Math.max(
    1,
    ...report.segments.distribution.map((item) => item.count),
  )
  return (
    <section
      className="rounded-2xl bg-white/90 p-5 shadow-sm shadow-indigo-950/5 sm:p-6"
      aria-labelledby="duration-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="duration-heading"
            className="text-lg font-semibold tracking-tight text-slate-950"
          >
            连续投入通常持续多久
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            只统计不少于 2 分钟、且不属于实验模式的片段。
          </p>
        </div>
        <Badge variant="secondary">
          中位数 {formatEvidenceDuration(report.segments.median_seconds)}
        </Badge>
      </div>
      <div className="mt-7 space-y-4">
        {report.segments.distribution.map((item) => (
          <div
            key={item.id}
            className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-3 text-sm"
          >
            <span className="text-slate-600">{item.label}</span>
            <div className="h-2.5 overflow-hidden rounded-full bg-indigo-50">
              <div
                className="h-full rounded-full bg-indigo-600 transition-[width] duration-500"
                style={{
                  width: item.count
                    ? String(Math.max(8, (item.count / maximum) * 100)) + "%"
                    : "0%",
                }}
              />
            </div>
            <span className="text-right font-medium text-slate-800 tabular-nums">
              {item.count}
            </span>
          </div>
        ))}
      </div>
      {report.segments.backfilled_count > 0 ? (
        <p className="mt-6 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">
          其中 {report.segments.backfilled_count}{" "}
          个旧片段依据累计时长重建；总时长可靠，历史暂停边界为近似值。
        </p>
      ) : null}
    </section>
  )
}

function TimeEvidence({ report }: { report: InsightsReport }) {
  return (
    <section
      className="rounded-2xl bg-white/90 p-5 shadow-sm shadow-indigo-950/5 sm:p-6"
      aria-labelledby="time-heading"
    >
      <h2
        id="time-heading"
        className="text-lg font-semibold tracking-tight text-slate-950"
      >
        一天中记录发生在哪些时段
      </h2>
      <p className="mt-1 text-sm leading-6 text-slate-500">
        自评至少 2 次后，时段才会进入个性化建议。
      </p>
      <div className="mt-5 divide-y divide-indigo-50">
        {report.time_buckets.map((bucket) => (
          <div
            key={bucket.id}
            className="grid grid-cols-[1fr_auto] items-center gap-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]"
          >
            <div>
              <p className="font-medium text-slate-800">{bucket.label}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {bucket.segment_count} 个有效片段
              </p>
            </div>
            <span className="text-right text-slate-600 tabular-nums">
              {formatEvidenceDuration(bucket.actual_seconds)}
            </span>
            <div className="col-span-2 flex flex-wrap justify-end gap-x-3 gap-y-1 text-right text-xs text-slate-500 sm:col-span-1 sm:block sm:min-w-36">
              <p className="font-medium text-slate-900 tabular-nums">
                {bucket.average_rating === null
                  ? "暂无自评"
                  : `${bucket.average_rating}/5 · ${bucket.reviewed_count} 次复盘`}
              </p>
              <p className="mt-0.5 tabular-nums">
                {bucket.completion_percent === null
                  ? "暂无会话完成结果"
                  : `完成 ${formatPercent(bucket.completion_percent)} · ${bucket.outcome_count} 次结束会话`}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function InsightsScreen() {
  const [days, setDays] = useState<InsightWindow>(30)
  const query = useInsights(days)
  const preferences = useInsightsPreferencesMutation()
  const browserTimezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    [],
  )
  if (query.isLoading) return <Loading />
  if (query.isError || !query.data)
    return (
      <Alert className="mx-auto max-w-2xl border-red-200 bg-white">
        <RefreshCw />
        <AlertTitle>长期记录暂时没有加载出来</AlertTitle>
        <AlertDescription className="mt-2">
          {query.error?.message}
          <Button
            className="mt-4"
            size="sm"
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            重试
          </Button>
        </AlertDescription>
      </Alert>
    )

  const report = query.data
  const suggestion = buildInsightSuggestion(report)
  const savePreferences = async (
    enabled: boolean,
    timezone = report.period.timezone,
  ) => {
    try {
      await preferences.mutateAsync({ enabled, timezone })
      toast.success("洞察设置已保存")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "洞察设置保存失败")
    }
  }

  return (
    <div className="space-y-7">
      <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            你实际是怎么投入时间的
          </h1>
          <p className="mt-3 max-w-2xl leading-7 text-slate-600">
            只呈现可追溯的个人记录。样本不足时显示收集进度，不把画面信号解释成“走神”。
          </p>
        </div>
        <div
          className="inline-flex self-start rounded-xl bg-indigo-100/70 p-1"
          aria-label="洞察时间范围"
        >
          {windows.map((item) => (
            <Button
              key={item.value}
              size="sm"
              variant={days === item.value ? "default" : "ghost"}
              aria-pressed={days === item.value}
              onClick={() => setDays(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </header>

      {!report.data_coverage.period_complete ||
      !report.data_coverage.recommendation_evidence_complete ? (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950">
          <TriangleAlert />
          <AlertTitle>
            {report.data_coverage.period_complete
              ? "30 天建议证据池包含不完整区间"
              : "这份汇总包含不完整的历史区间"}
          </AlertTitle>
          <AlertDescription className="mt-2 leading-6">
            {report.data_coverage.period_complete
              ? "当前查看窗口的数据完整，但形成建议所用的近 30 天证据池曾达到数据库安全容量上限。当前汇总仍可回看，本轮不会生成个性化规律建议。"
              : "当前查看窗口内的派生事实曾达到数据库安全容量上限，部分新事实被跳过。数字仍可用于回看，但不会生成个性化规律建议；删除旧数据也无法补回当时未记录的事实。"}
          </AlertDescription>
        </Alert>
      ) : null}

      {!report.enabled ? (
        <Alert className="border-indigo-200 bg-white">
          <Sparkles />
          <AlertTitle>长期洞察已关闭</AlertTitle>
          <AlertDescription className="mt-2">
            已有事实记录会保留；关闭期间不会采集投入段、观察区间或任务步骤历史。重新开启后只从当下继续，不回填关闭区间。
            <Button
              className="mt-4"
              onClick={() => void savePreferences(true)}
              disabled={preferences.isPending}
            >
              {preferences.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Sparkles />
              )}
              开启洞察
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <section
            className="grid overflow-hidden rounded-2xl bg-white/90 shadow-sm shadow-indigo-950/5 sm:grid-cols-2 lg:grid-cols-4"
            aria-label="本期摘要"
          >
            <Metric
              icon={CalendarDays}
              label="活跃天数"
              value={String(report.overview.active_days) + " 天"}
              note={"当前 " + days + " 天窗口"}
            />
            <Metric
              icon={CheckCircle2}
              label="完成任务"
              value={String(report.overview.completed_tasks) + " 个"}
              note="按明确完成时间统计"
            />
            <Metric
              icon={Clock3}
              label="实际投入"
              value={formatEvidenceDuration(report.overview.actual_seconds)}
              note={String(report.segments.eligible_count) + " 个有效片段"}
            />
            <Metric
              icon={Activity}
              label="复盘覆盖"
              value={formatPercent(report.overview.review_coverage_percent)}
              note={
                report.overview.reviewed_sessions +
                "/" +
                report.overview.terminal_sessions +
                " 次终结会话"
              }
            />
          </section>
          {report.segments.eligible_count === 0 ? (
            <Alert className="border-indigo-100 bg-white/80">
              <Clock3 />
              <AlertTitle>当前窗口还没有有效投入片段</AlertTitle>
              <AlertDescription>
                完成一段不少于 2
                分钟的非实验记录后，这里才会开始统计时长和时段。
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
            <DurationEvidence report={report} />
            <TimeEvidence report={report} />
          </div>
          <section
            className="rounded-2xl bg-emerald-50/80 p-5 shadow-sm shadow-emerald-950/5 sm:p-6"
            aria-labelledby="suggestion-heading"
          >
            <div className="flex items-start gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white">
                <Sparkles className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="suggestion-heading"
                  className="text-xl font-semibold tracking-tight text-emerald-950"
                >
                  {suggestion.title}
                </h2>
                <p className="mt-2 max-w-4xl text-sm leading-6 text-emerald-950/80">
                  {suggestion.detail}
                </p>
                {!suggestion.ready ? (
                  <div className="mt-4 max-w-md">
                    <div className="mb-2 flex justify-between text-xs text-emerald-900">
                      <span>形成建议所需样本</span>
                      <span>{suggestion.progressPercent}%</span>
                    </div>
                    <Progress value={suggestion.progressPercent} />
                  </div>
                ) : null}
                {suggestion.precursorStatement ? (
                  <p className="mt-4 rounded-xl bg-white/60 px-4 py-3 text-sm leading-6 text-emerald-950">
                    {suggestion.precursorStatement}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
          <section
            className="rounded-2xl bg-white/90 p-5 shadow-sm shadow-indigo-950/5 sm:p-6"
            aria-labelledby="observation-heading"
          >
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Camera className="mt-0.5 size-5 shrink-0 text-indigo-600" />
                <div>
                  <h2
                    id="observation-heading"
                    className="font-semibold text-slate-950"
                  >
                    可选视觉观察的覆盖情况
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    仅汇总开启摄像头的时间和经你确认的结构化事件；不保存画面或关键点。
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-right sm:grid-cols-4">
                <div>
                  <p className="text-xl font-semibold tabular-nums">
                    {formatEvidenceDuration(
                      report.observation.observed_seconds,
                    )}
                  </p>
                  <p className="text-xs text-slate-500">观察时长</p>
                </div>
                <div>
                  <p className="text-xl font-semibold tabular-nums">
                    {formatPercent(report.observation.coverage_percent)}
                  </p>
                  <p className="text-xs text-slate-500">时间覆盖</p>
                </div>
                <div>
                  <p className="text-xl font-semibold tabular-nums">
                    {report.observation.confirmed_event_count}
                  </p>
                  <p className="text-xs text-slate-500">确认事件</p>
                </div>
                <div>
                  <p className="text-xl font-semibold tabular-nums">
                    {report.observation.observed_seconds > 0
                      ? `${report.observation.confirmed_events_per_hour}/小时`
                      : "—"}
                  </p>
                  <p className="text-xs text-slate-500">确认事件率</p>
                </div>
              </div>
            </div>
            <div className="mt-5 border-t border-indigo-50 pt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-slate-800">
                  轻提醒后的反馈
                </h3>
                <p className="text-xs text-slate-500 tabular-nums">
                  尚未反馈 {report.observation.reminder_responses.none} 次
                </p>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {reminderResponseLabels.map(([id, label]) => (
                  <div
                    key={id}
                    className="flex items-center justify-between rounded-xl bg-indigo-50/60 px-3 py-2 text-xs text-slate-600 lg:block"
                  >
                    <span>{label}</span>
                    <strong className="ml-2 font-semibold text-slate-900 tabular-nums lg:mt-1 lg:block lg:text-base">
                      {report.observation.reminder_responses[id]}
                    </strong>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                事件率只表示“经你确认的画面变化 ÷ 实际观察时长”，不是专注评分。
              </p>
            </div>
          </section>
        </>
      )}

      <Separator />
      <section
        className="flex flex-col justify-between gap-5 rounded-2xl bg-white/60 px-5 py-4 sm:flex-row sm:items-center"
        aria-label="洞察数据设置"
      >
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 size-4 text-slate-500" />
          <div>
            <p className="text-sm font-medium text-slate-800">
              统计时区：{report.period.timezone}
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              修改时区会用新时区重新解释全部既有记录。跨时段会话的复盘与结果归到实际投入最长的时段；步骤改名前后的标题会保留在事实历史中。关闭洞察会立即封口并停止采集，但不会删除已有事实。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {browserTimezone !== report.period.timezone ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void savePreferences(report.enabled, browserTimezone)
              }
              disabled={preferences.isPending}
            >
              使用设备时区
            </Button>
          ) : null}
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700">
            <Switch
              checked={report.enabled}
              onCheckedChange={(value) => void savePreferences(value)}
              disabled={preferences.isPending}
            />
            生成长期洞察
          </label>
        </div>
      </section>
    </div>
  )
}
