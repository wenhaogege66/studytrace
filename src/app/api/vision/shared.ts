import { createClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

export function visionJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export function visionRpcError(error: { code?: string }) {
  const status =
    error.code === "42501"
      ? 403
      : error.code === "P0002"
        ? 404
        : error.code === "P0001"
          ? 409
          : error.code === "22023" || error.code === "23514"
            ? 400
            : 503
  return visionJson(
    {
      error: status === 503 ? "VISION_UNAVAILABLE" : "VISION_REQUEST_REJECTED",
    },
    status,
  )
}

export async function authenticatedVisionClient(request: Request) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!token || !url || !key) return null
  const client = createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data, error } = await client.auth.getUser(token)
  return error || !data.user ? null : client
}
