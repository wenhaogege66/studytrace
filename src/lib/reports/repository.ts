import { z } from "zod"

import { getSupabase } from "@/lib/supabase/client"
import { learningReportContentSchema, reportSnapshotSchema } from "./contracts"

const reportRowSchema = z.object({
  id: z.string().uuid(),
  period_days: z.union([z.literal(7), z.literal(30)]),
  source: z.enum(["manual", "weekly"]),
  status: z.enum(["pending", "ready", "failed"]),
  content: learningReportContentSchema.nullable(),
  input_snapshot: reportSnapshotSchema,
  model_id: z.string().nullable(),
  generated_at: z.string().nullable(),
  read_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type SavedLearningReport = z.infer<typeof reportRowSchema>

export async function getMyAiReports(userId: string, days: 7 | 30) {
  const { data, error } = await getSupabase()
    .from("ai_reports")
    .select(
      "id,period_days,source,status,content,input_snapshot,model_id,generated_at,read_at,created_at,updated_at",
    )
    .eq("user_id", userId)
    .eq("period_days", days)
    .order("created_at", { ascending: false })
    .limit(10)
  if (error) throw new Error("AI 学习报告暂时无法读取，请稍后重试")
  return z.array(reportRowSchema).parse(data)
}

export async function requestAiReport(days: 7 | 30, expectedUserId: string) {
  const { data } = await getSupabase().auth.getSession()
  if (!data.session || data.session.user.id !== expectedUserId)
    throw new Error("身份已变化，请在当前账号重新操作")
  const response = await fetch("/api/reports/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ days }),
  })
  const body = (await response.json()) as {
    error?: string
    state?: string
    reportId?: string
  }
  if (!response.ok)
    throw new Error(
      body.state === "quota"
        ? "今日 AI 报告额度已用完，明天可再试；事实报告不受影响"
        : (body.error ?? "AI 报告生成失败"),
    )
  if (body.state === "retry_limit")
    throw new Error("该快照暂时无法生成报告，请新增学习记录后再试")
  return body
}

export async function markReportRead(id: string) {
  const { error } = await getSupabase().rpc("mark_my_ai_report_read", {
    p_report_id: id,
  })
  if (error) throw new Error("报告未读状态暂时未同步")
}

export async function getReportSchedule() {
  const { data, error } = await getSupabase().rpc("get_my_ai_report_schedule")
  if (error) throw new Error("自动报告时间暂时无法读取")
  return z
    .object({ enabled: z.boolean(), next_due_at: z.string().nullable() })
    .parse(data)
}
