import { createClient } from "@supabase/supabase-js"

import type { Database } from "@/types/database"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export function apiJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function authenticateRequest(request: Request) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!token || !url || !key) {
    throw new ApiError(401, "使用状态已失效，请重新进入后再试")
  }
  const supabase = createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    throw new ApiError(401, "使用状态已失效，请重新进入后再试")
  }
  return { supabase, user: data.user, token }
}

export async function readBoundedJson(request: Request, maxBytes = 32_768) {
  const length = Number(request.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ApiError(413, "提交内容过大，请缩小后重试")
  }
  if (!request.body) throw new ApiError(400, "请求内容为空")
  const reader = request.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new ApiError(413, "提交内容过大，请缩小后重试")
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, "提交格式不正确，请检查后重试")
  } finally {
    reader.releaseLock()
  }
}

export function apiFailure(error: unknown, fallback: string) {
  return error instanceof ApiError
    ? apiJson({ error: error.message }, error.status)
    : apiJson({ error: fallback }, 503)
}
