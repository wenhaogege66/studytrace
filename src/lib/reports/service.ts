import "server-only"

import { z } from "zod"

import { ApiError } from "@/lib/server/api"
import { getServiceSupabase } from "@/lib/server/supabase-service"
import { reportSnapshotSchema } from "./contracts"
import { generateLearningReport, reportProviderConfigured } from "./generator"

const claimSchema = z.object({
  state: z.string(),
  report_id: z.string().uuid().optional(),
  lease_token: z.string().uuid().optional(),
  snapshot: z.unknown().optional(),
})

export async function runReportJob(
  userId: string,
  days: 7 | 30,
  source: "manual" | "weekly",
  signal?: AbortSignal,
) {
  if (!reportProviderConfigured())
    throw new ApiError(503, "AI 学习报告尚未配置，事实报告仍可使用")
  const db = getServiceSupabase()
  const { data, error } = await db.rpc("claim_learning_report", {
    p_user_id: userId,
    p_days: days,
    p_source: source,
  })
  if (error)
    throw new ApiError(
      error.code === "42501" ? 403 : 503,
      error.code === "42501"
        ? "请先开启 AI 报告授权和学习记录统计"
        : "报告暂时无法准备，请稍后重试",
    )
  const claim = claimSchema.parse(data)
  if (claim.state !== "claimed")
    return { state: claim.state, reportId: claim.report_id }
  if (!claim.report_id || !claim.lease_token)
    throw new Error("REPORT_INVALID_LEASE")
  try {
    const snapshot = reportSnapshotSchema.parse(claim.snapshot)
    const generated = await generateLearningReport(snapshot, signal)
    const finished = await db.rpc("finish_learning_report", {
      p_report_id: claim.report_id,
      p_lease_token: claim.lease_token,
      p_content: generated.content,
      p_model_id: generated.modelId,
      p_token_usage: generated.usage,
    })
    if (finished.error || !finished.data)
      throw new ApiError(409, "报告授权或生成状态已变化，本次结果未保存")
    return { state: "ready", reportId: claim.report_id }
  } catch (error) {
    await db.rpc("finish_learning_report", {
      p_report_id: claim.report_id,
      p_lease_token: claim.lease_token,
      p_content: {},
      p_model_id: "unavailable",
      p_token_usage: {},
      p_error_code: signal?.aborted ? "cancelled" : "provider_unavailable",
    })
    if (error instanceof ApiError) throw error
    throw new ApiError(
      502,
      "AI 暂时未能生成报告，未切换付费模型；事实报告仍可使用",
    )
  }
}
