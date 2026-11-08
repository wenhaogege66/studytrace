"use client"

import { useQuery } from "@tanstack/react-query"
import { useExperience } from "@/components/experience/experience-provider"
import { getReportSchedule } from "@/lib/reports/repository"

export function ReportSchedule() {
  const { user } = useExperience()
  const schedule = useQuery({
    queryKey: ["ai-reports", user?.id, "schedule"],
    queryFn: getReportSchedule,
    enabled: Boolean(user),
  })
  if (user?.is_anonymous)
    return (
      <p className="mt-3 text-xs leading-6 text-slate-500">
        临时体验可以主动生成 AI 解读，不会后台自动生成报告。
      </p>
    )
  return (
    <p className="mt-3 text-xs leading-6 text-slate-500">
      {schedule.data?.enabled && schedule.data.next_due_at
        ? `下次七天自动报告检查：${new Date(schedule.data.next_due_at).toLocaleString("zh-CN")}。每日检查，无新学习记录时跳过；服务繁忙或额度不足时会延后。`
        : "七天自动生成默认关闭。开启后第七天首次检查，可随时关闭。"}
    </p>
  )
}
