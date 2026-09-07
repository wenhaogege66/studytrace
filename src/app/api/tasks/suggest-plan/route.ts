import { createClient } from "@supabase/supabase-js"
import { z } from "zod"

import { taskPlanRequestSchema } from "@/lib/ai/task-plan-contract"
import { generateTaskPlan } from "@/lib/ai/task-plan"
import type { Database } from "@/types/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 20

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

async function authenticatedClient(request: Request) {
  const authorization = request.headers.get("authorization")
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!token || !supabaseUrl || !publishableKey) return null

  const supabase = createClient<Database>(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await supabase.auth.getUser(token)
  return error || !data.user ? null : { supabase, user: data.user }
}

export async function POST(request: Request) {
  const authentication = await authenticatedClient(request)
  if (!authentication)
    return json({ error: "匿名体验已失效，请刷新后重试" }, 401)

  let input: z.infer<typeof taskPlanRequestSchema>
  try {
    input = taskPlanRequestSchema.parse(await request.json())
  } catch (error) {
    if (error instanceof z.ZodError)
      return json({ error: "请提供 1～120 字的任务标题" }, 400)
    return json({ error: "请求格式不正确" }, 400)
  }

  const quota = await authentication.supabase.rpc("consume_ai_generation_quota")
  if (quota.error)
    return json({ error: "AI 配额暂时无法校验，可继续手动填写" }, 503)
  if (!quota.data)
    return json(
      { error: "当前匿名会话或今日 AI 配额已达上限，请稍后再试" },
      429,
    )

  try {
    const suggestion = await generateTaskPlan(input, request.signal)
    return json(suggestion)
  } catch (error) {
    if (error instanceof Error && error.message === "QWEN_NOT_CONFIGURED")
      return json({ error: "AI 步骤生成尚未配置，可继续手动填写" }, 503)
    if (error instanceof Error && error.message === "QWEN_INVALID_BASE_URL")
      return json({ error: "AI 服务地址配置不安全，可继续手动填写" }, 503)
    if (error instanceof Error && error.name === "AI_APICallError")
      return json({ error: "AI 暂时没有响应，可继续手动填写" }, 502)
    if (error instanceof Error && error.name === "TimeoutError")
      return json({ error: "AI 生成超时，可重试或手动填写" }, 504)

    return json({ error: "AI 暂时没有生成有效初稿，可继续手动填写" }, 502)
  }
}
