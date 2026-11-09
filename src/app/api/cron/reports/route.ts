import { timingSafeEqual } from "node:crypto"
import { z } from "zod"

import { apiJson } from "@/lib/server/api"
import { getServiceSupabase } from "@/lib/server/supabase-service"
import { reportProviderConfigured } from "@/lib/reports/generator"
import { runReportJob } from "@/lib/reports/service"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const supplied = request.headers.get("authorization") ?? ""
  const expected = `Bearer ${secret ?? ""}`
  const receivedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  if (
    !secret ||
    receivedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(receivedBytes, expectedBytes)
  )
    return apiJson({ error: "Unauthorized" }, 401)
  if (!reportProviderConfigured())
    return apiJson({ state: "not_configured", processed: 0 })
  try {
    const db = getServiceSupabase()
    const deadline = Date.now() + 270_000
    const visited: string[] = []
    const counts: Record<string, number> = {}
    let quotaReached = false
    while (
      Date.now() < deadline - 30_000 &&
      visited.length < 200 &&
      !quotaReached
    ) {
      const { data, error } = await db.rpc("list_due_learning_report_users", {
        p_limit: 4,
        p_exclude: visited,
      })
      if (error) throw error
      const users = z.array(z.string().uuid()).max(4).parse(data)
      if (users.length === 0) break
      visited.push(...users)
      const states = await Promise.all(
        users.map(async (id) => {
          try {
            return (
              await runReportJob(id, 7, "weekly", AbortSignal.timeout(26_000))
            ).state
          } catch {
            return "failed"
          }
        }),
      )
      for (const state of states) {
        counts[state] = (counts[state] ?? 0) + 1
        if (state === "quota") quotaReached = true
      }
    }
    const remaining = await db.rpc("list_due_learning_report_users", {
      p_limit: 1,
      p_exclude: visited,
    })
    return apiJson({
      processed: visited.length,
      states: counts,
      deferred:
        quotaReached ||
        (Array.isArray(remaining.data) && remaining.data.length > 0),
    })
  } catch {
    return apiJson({ error: "Scheduled report batch unavailable" }, 503)
  }
}
