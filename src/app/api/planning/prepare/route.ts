import { preparePlanningSchema } from "@/lib/planning/contract"
import { prepareLearningPlan } from "@/lib/planning/generate"
import { logAiFailure } from "@/lib/server/ai-diagnostics"
import {
  ApiError,
  apiFailure,
  apiJson,
  authenticateRequest,
  readBoundedJson,
} from "@/lib/server/api"

export const runtime = "nodejs"
export const maxDuration = 30

export async function POST(request: Request) {
  try {
    const { supabase } = await authenticateRequest(request)
    const input = preparePlanningSchema.safeParse(
      await readBoundedJson(request),
    )
    if (!input.success)
      throw new ApiError(400, "请补充学习意图，并检查时间与选项")
    const quota = await supabase.rpc("consume_ai_generation_quota")
    if (quota.error)
      throw new ApiError(503, "AI 额度暂时无法校验，可以先手动制定计划")
    if (!quota.data)
      throw new ApiError(429, "本阶段 AI 额度已用完，可以先手动制定计划")
    return apiJson(await prepareLearningPlan(input.data, request.signal))
  } catch (error) {
    const fallback = "暂时无法生成推荐方案，可以重试或使用手动方案"
    if (error instanceof ApiError) return apiFailure(error, fallback)
    const { category } = logAiFailure("planning.prepare", error)
    return apiJson(
      { error: fallback, code: `AI_${category.toUpperCase()}` },
      503,
    )
  }
}
