import { z } from "zod"

import {
  apiFailure,
  apiJson,
  authenticateRequest,
  readBoundedJson,
} from "@/lib/server/api"
import { runReportJob } from "@/lib/reports/service"

export const runtime = "nodejs"
export const maxDuration = 40

export async function POST(request: Request) {
  try {
    const { user } = await authenticateRequest(request)
    const input = z
      .object({ days: z.union([z.literal(7), z.literal(30)]) })
      .parse(await readBoundedJson(request, 1024))
    const result = await runReportJob(
      user.id,
      input.days,
      "manual",
      request.signal,
    )
    return apiJson(
      result,
      result.state === "quota" ? 429 : result.state === "pending" ? 202 : 200,
    )
  } catch (error) {
    if (error instanceof z.ZodError)
      return apiJson({ error: "请选择 7 天或 30 天报告" }, 400)
    return apiFailure(error, "报告暂时无法生成")
  }
}
