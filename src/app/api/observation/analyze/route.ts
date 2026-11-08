import { createClient } from "@supabase/supabase-js"
import { analyzeObservation, visionConfiguration } from "@/lib/ai/observation"
import {
  ApiError,
  apiFailure,
  apiJson,
  authenticateRequest,
  readBoundedJson,
} from "@/lib/server/api"
import { observationAgreementSchema } from "@/lib/vision/agreement"
import { cloudRequestSchema } from "@/lib/vision/cloud-contract"
import type { Database } from "@/types/app-database"

export const maxDuration = 30
export async function POST(request: Request) {
  try {
    const { supabase } = await authenticateRequest(request)
    const parsed = cloudRequestSchema.safeParse(
      await readBoundedJson(request, 750_000),
    )
    if (!parsed.success)
      throw new ApiError(400, "观察图像序列无效，请重新开启摄像头")
    const input = parsed.data
    const secret = process.env.SUPABASE_SECRET_KEY
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    if (!visionConfiguration() || !secret || !url)
      throw new ApiError(503, "云端过程观察尚未启用；本地观察和计时可继续使用")
    const { data, error } = await supabase.rpc("prepare_cloud_observation", {
      p_session_id: input.sessionId,
      p_window_id: input.windowId,
      p_started_at: input.frames[0].capturedAt,
      p_ended_at: input.frames[3].capturedAt,
    })
    if (error) {
      if (error.code === "P0001")
        throw new ApiError(
          429,
          "已达到云端观察的频率或免费预算上限，本地观察继续运行",
        )
      throw new ApiError(
        403,
        "云端观察未获授权或本次学习已暂停，请检查观察设置",
      )
    }
    const reservation = data as {
      status?: string
      result?: unknown
      agreement?: unknown
    }
    if (reservation.status === "complete") return apiJson(reservation.result)
    if (reservation.status !== "reserved")
      throw new ApiError(409, "该观察窗口正在处理或已失效")
    const agreement = observationAgreementSchema.parse(reservation.agreement)
    if (request.signal.aborted) throw new ApiError(409, "本次观察已停止")
    const { result, model, usage } = await analyzeObservation(
      input,
      agreement,
      request.signal,
    )
    if (request.signal.aborted) throw new ApiError(409, "本次观察已停止")
    const admin = createClient<Database>(url, secret, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
    const finished = await admin.rpc("finish_cloud_observation", {
      p_window_id: input.windowId,
      p_result: { ...result, usage },
      p_model: model,
    })
    if (finished.error)
      throw new ApiError(503, "观察结果未保存，本地观察仍可继续")
    return apiJson({ ...(finished.data as Record<string, unknown>), usage })
  } catch (error) {
    // Never expose or log provider error objects: some SDKs include image input.
    return apiFailure(
      error,
      "云端观察暂不可用或免费额度不足，本地观察和计时不会中断",
    )
  }
}
