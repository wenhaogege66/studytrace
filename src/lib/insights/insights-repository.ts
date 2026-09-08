import { getSupabase } from "@/lib/supabase/client"

import {
  parseInsightsReport,
  type InsightWindow,
  type InsightsReport,
} from "./insights"

type RpcError = { message: string; code?: string } | null

function fail(message: string, error: Exclude<RpcError, null>): never {
  const normalized = error.message.toLocaleLowerCase()
  if (
    error.code === "42501" ||
    normalized.includes("permission denied") ||
    normalized.includes("authentication required")
  )
    throw new Error("当前体验会话已失效，请刷新页面后重试")
  if (error.code === "22023")
    throw new Error("这个洞察设置暂不受支持，请更换后重试")
  if (normalized.includes("fetch") || normalized.includes("network"))
    throw new Error("网络连接失败，请检查网络后重试")
  throw new Error(message)
}

export async function getMyInsights(
  days: InsightWindow,
): Promise<InsightsReport> {
  const { data, error } = await getSupabase().rpc("get_my_insights", {
    p_days: days,
  })
  if (error) fail("读取长期记录失败", error)

  try {
    return parseInsightsReport(data)
  } catch {
    throw new Error("读取长期记录失败：聚合结果格式异常")
  }
}

export async function updateMyInsightsPreferences(input: {
  enabled: boolean
  timezone: string
}) {
  const { data, error } = await getSupabase().rpc(
    "update_my_insights_preferences",
    {
      p_enabled: input.enabled,
      p_timezone: input.timezone,
    },
  )
  if (error) fail("保存洞察设置失败", error)
  return data as { enabled: boolean; timezone: string }
}
