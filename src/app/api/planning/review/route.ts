import { planningReviewRequestSchema } from "@/lib/planning/contract"
import { reviewLearningPlan } from "@/lib/planning/generate"
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
    const input = planningReviewRequestSchema.safeParse(
      await readBoundedJson(request),
    )
    if (!input.success)
      throw new ApiError(400, "推荐方案格式不完整，请检查后再试")
    const quota = await supabase.rpc("consume_ai_generation_quota")
    if (quota.error)
      throw new ApiError(503, "AI 额度暂时无法校验，可直接保留你的方案")
    if (!quota.data)
      throw new ApiError(429, "AI 额度已用完，可直接保留你的方案")
    return apiJson(await reviewLearningPlan(input.data, request.signal))
  } catch (error) {
    return apiFailure(error, "暂时无法点评修改，可直接保留你的方案")
  }
}
