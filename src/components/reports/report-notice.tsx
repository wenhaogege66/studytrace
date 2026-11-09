"use client"

import { useQuery } from "@tanstack/react-query"
import { ArrowRight, FileText } from "lucide-react"
import Link from "next/link"

import { useExperience } from "@/components/experience/experience-provider"
import { getSupabase } from "@/lib/supabase/client"

export function ReportNotice() {
  const { user } = useExperience()
  const notice = useQuery({
    queryKey: ["ai-reports", user?.id, "unread"],
    enabled: Boolean(user),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await getSupabase()
        .from("ai_reports")
        .select("id")
        .eq("user_id", user!.id)
        .eq("source", "weekly")
        .eq("status", "ready")
        .is("read_at", null)
        .limit(1)
      return error ? false : Boolean(data.length)
    },
  })
  if (!notice.data) return null
  return (
    <Link
      href="/app/insights?period=7#ai-report"
      className="mb-5 flex min-h-12 items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 print:hidden"
    >
      <span className="flex items-center gap-2">
        <FileText className="size-4" />
        本周学习报告已生成
        <span
          className="size-1.5 rounded-full bg-emerald-600"
          aria-label="未读"
        />
      </span>
      <span className="flex items-center gap-1 text-xs">
        查看
        <ArrowRight className="size-3.5" />
      </span>
    </Link>
  )
}
