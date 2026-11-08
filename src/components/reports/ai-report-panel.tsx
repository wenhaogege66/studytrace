"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, LoaderCircle, Sparkles } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useExperience } from "@/components/experience/experience-provider"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getMyConsents, hasConsent, setMyConsent } from "@/lib/privacy/consents"
import { buildReportEvidence } from "@/lib/reports/contracts"
import {
  getMyAiReports,
  getReportSchedule,
  markReportRead,
  requestAiReport,
  type SavedLearningReport,
} from "@/lib/reports/repository"

export const reportKeys = {
  all: (userId: string) => ["ai-reports", userId] as const,
}

function ReportContent({ report }: { report: SavedLearningReport }) {
  const content = report.content
  if (!content) return null
  const evidence = buildReportEvidence(report.input_snapshot)
  return (
    <article className="mt-6 space-y-6" aria-label="AI 解读内容">
      <header>
        <p className="text-xs text-slate-500">
          AI 解读 ·{" "}
          {report.generated_at
            ? new Date(report.generated_at).toLocaleString("zh-CN")
            : ""}{" "}
          · {report.period_days} 天快照
        </p>
        <h3 className="mt-2 text-xl font-semibold text-slate-950">
          {content.title}
        </h3>
        <p className="mt-3 text-sm leading-7 text-slate-700">
          {content.summary}
        </p>
      </header>
      <div className="space-y-5">
        {content.conclusions.map((item, index) => (
          <section key={index} className="border-l-2 border-indigo-200 pl-4">
            <p className="leading-7 font-medium text-slate-900">
              {item.statement}
            </p>
            <p className="mt-1 text-xs leading-6 text-slate-500">
              局限：{item.limitation}
            </p>
            <p className="text-xs leading-6 text-indigo-700">
              依据：
              {item.evidence
                .map((id) => evidence.find((row) => row.id === id)?.label ?? id)
                .join("、")}
            </p>
          </section>
        ))}
      </div>
      <section className="rounded-xl bg-emerald-50 p-4">
        <h4 className="text-sm font-semibold text-emerald-950">
          值得肯定的行动
        </h4>
        <p className="mt-2 text-sm leading-7 text-emerald-950">
          {content.encouragement.text}
        </p>
        <p className="text-xs text-emerald-800">
          依据：
          {content.encouragement.evidence
            .map((id) => evidence.find((row) => row.id === id)?.label ?? id)
            .join("、")}
        </p>
      </section>
      <section>
        <h4 className="font-semibold">下一阶段可尝试</h4>
        <ol className="mt-3 space-y-4">
          {content.experiments.map((item, index) => (
            <li key={index} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-indigo-50 text-xs text-indigo-700">
                {index + 1}
              </span>
              <div>
                <p className="text-sm font-medium">{item.action}</p>
                <p className="mt-1 text-xs leading-6 text-slate-500">
                  {item.reason}
                </p>
                <p className="text-xs text-indigo-700">
                  依据：
                  {item.evidence
                    .map(
                      (id) =>
                        evidence.find((row) => row.id === id)?.label ?? id,
                    )
                    .join("、")}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <details className="border-t border-slate-100 pt-4">
        <summary className="min-h-11 cursor-pointer text-sm font-medium">
          查看统计依据与局限
        </summary>
        <dl className="mt-2 divide-y divide-slate-100">
          {evidence.map((item) => (
            <div key={item.id} className="py-2 text-xs leading-6">
              <dt className="font-medium text-slate-800">
                {item.label} · 样本 {item.samples}
              </dt>
              <dd className="text-slate-500">{item.value}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-3 space-y-1 text-xs leading-6 text-slate-500">
          {content.limitations.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-400">
          模型：{report.model_id}；AI
          解释不替代你的判断。可在设置中撤回后续处理授权。
        </p>
      </details>
    </article>
  )
}

function AiReportPanelContent({ days }: { days: 7 | 30 }) {
  const { user } = useExperience()
  const userId = user?.id ?? ""
  const cache = useQueryClient()
  const [consentOpen, setConsentOpen] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [weekly, setWeekly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const consent = useQuery({
    queryKey: ["consents", userId],
    queryFn: getMyConsents,
    enabled: Boolean(userId),
  })
  const schedule = useQuery({
    queryKey: [...reportKeys.all(userId), "schedule"],
    queryFn: getReportSchedule,
    enabled: Boolean(userId),
  })
  const reports = useQuery({
    queryKey: [...reportKeys.all(userId), days],
    queryFn: () => getMyAiReports(userId, days),
    enabled: Boolean(userId),
    refetchInterval: (query) =>
      query.state.data?.some(
        (item) =>
          item.status === "pending" &&
          Date.now() - Date.parse(item.updated_at) < 180_000,
      )
        ? 5000
        : false,
  })
  const current =
    reports.data?.find(
      (item) => item.id === selectedId && item.status === "ready",
    ) ?? reports.data?.find((item) => item.status === "ready")
  const generate = useMutation({
    mutationFn: () => requestAiReport(days, userId),
    onSuccess: async (result) => {
      await cache.invalidateQueries({ queryKey: reportKeys.all(userId) })
      if (result.reportId) setSelectedId(result.reportId)
      toast.success(
        result.state === "pending"
          ? "这份报告正在生成，请稍候"
          : result.state === "cached"
            ? "已打开相同数据快照的解读"
            : "AI 学习报告已生成",
      )
    },
    onError: (error) => toast.error(error.message),
  })
  const authorize = useMutation({
    mutationFn: async () => {
      await setMyConsent("ai_reports", true, userId)
      if (weekly && !user?.is_anonymous)
        await setMyConsent("weekly_reports", true, userId)
    },
    onSuccess: async () => {
      setConsentOpen(false)
      setAccepted(false)
      setWeekly(false)
      await cache.invalidateQueries({ queryKey: ["consents", userId] })
      await cache.invalidateQueries({ queryKey: reportKeys.all(userId) })
      generate.mutate()
    },
    onError: (error) => toast.error(error.message),
  })
  useEffect(() => {
    if (!current || current.read_at) return
    void markReportRead(current.id)
      .then(() => cache.invalidateQueries({ queryKey: reportKeys.all(userId) }))
      .catch(() => undefined)
  }, [current, cache, userId])
  return (
    <section
      id="ai-report"
      className="rounded-2xl border border-indigo-100 bg-white p-5 sm:p-6"
      aria-labelledby="ai-report-title"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="max-w-2xl">
          <h2
            id="ai-report-title"
            className="flex items-center gap-2 text-lg font-semibold"
          >
            <Sparkles className="size-5 text-indigo-600" />
            把记录变成下一步
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            AI
            解读真实记录、采用的方法与方案调整。不足的样本会明确说明，不把观察线索当作结论。
          </p>
        </div>
        <Button
          disabled={
            generate.isPending || authorize.isPending || consent.isPending
          }
          onClick={() =>
            hasConsent(consent.data, "ai_reports")
              ? generate.mutate()
              : setConsentOpen(true)
          }
        >
          {generate.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Sparkles />
          )}
          {generate.isPending ? "正在生成" : "生成 AI 解读"}
        </Button>
      </div>
      <p className="mt-3 text-xs leading-6 text-slate-500">
        每天最多主动生成两次；相同数据快照优先复用。
        {schedule.data?.enabled && schedule.data.next_due_at
          ? `下次七天自动报告：${new Date(schedule.data.next_due_at).toLocaleDateString("zh-CN")}。`
          : "七天自动报告默认关闭。"}
      </p>
      {reports.isError ? (
        <p className="mt-4 text-sm text-amber-800">{reports.error.message}</p>
      ) : null}
      {reports.data?.some((item) => item.status === "pending") ? (
        <p className="mt-4 text-sm text-indigo-700" role="status">
          已有报告正在生成，请稍候；你可以继续查看事实报告。
        </p>
      ) : null}
      {current ? (
        <>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <label className="text-xs text-slate-500">
              历史快照{" "}
              <select
                className="ml-2 min-h-11 max-w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                value={current.id}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {reports.data
                  ?.filter((item) => item.status === "ready")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {new Date(item.created_at).toLocaleString("zh-CN")}
                      {item.read_at ? "" : " · 未读"}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(current, null, 2)], {
                    type: "application/json",
                  }),
                )
                const link = document.createElement("a")
                link.href = url
                link.download = `studytrace-ai-report-${days}d.json`
                link.click()
                URL.revokeObjectURL(url)
              }}
            >
              <Download />
              导出解读
            </Button>
          </div>
          <ReportContent report={current} />
        </>
      ) : !reports.isPending ? (
        <p className="mt-5 border-t border-slate-100 pt-5 text-sm leading-7 text-slate-500">
          还没有 AI
          解读。即使暂时没有长期样本，也可以从已有记录得到一份注明局限的阶段总结。
        </p>
      ) : null}
      <Dialog
        open={consentOpen}
        onOpenChange={(open) => {
          setConsentOpen(open)
          if (!open) {
            setAccepted(false)
            setWeekly(false)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>允许 AI 解读学习记录？</DialogTitle>
            <DialogDescription className="leading-7">
              将向阿里云百炼发送本人聚合统计、采用方案和相关修订摘要，不发送摄像头画面。服务商会按自身数据处理条款处理请求；我们不承诺第三方零留存。你可以随时在设置中撤回。
            </DialogDescription>
          </DialogHeader>
          <a
            className="text-sm text-indigo-700 underline"
            href="https://help.aliyun.com/zh/model-studio/"
            target="_blank"
            rel="noreferrer"
          >
            了解百炼服务与数据处理说明
          </a>
          <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
            <Checkbox
              checked={accepted}
              onCheckedChange={(value) => setAccepted(value === true)}
              className="mt-1"
            />
            我同意将上述数据用于生成 AI 学习报告（可选）
          </label>
          {!user?.is_anonymous ? (
            <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
              <Checkbox
                checked={weekly}
                onCheckedChange={(value) => setWeekly(value === true)}
                className="mt-1"
              />
              同时开启每七天自动生成（可选；无新学习记录时跳过）
            </label>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConsentOpen(false)}>
              仅查看事实报告
            </Button>
            <Button
              disabled={!accepted || authorize.isPending}
              onClick={() => authorize.mutate()}
            >
              {authorize.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              授权并生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export function AiReportPanel({ days }: { days: 7 | 30 }) {
  const { user } = useExperience()
  return <AiReportPanelContent key={user?.id ?? "none"} days={days} />
}
