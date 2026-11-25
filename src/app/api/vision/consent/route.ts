import {
  authenticatedVisionClient,
  visionJson,
  visionRpcError,
} from "../shared"
import {
  readVisionJson,
  visionConsentSchema,
} from "@/lib/ai/vision-observation-contract"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const client = await authenticatedVisionClient(request)
    if (!client) return visionJson({ error: "VISION_AUTH_REQUIRED" }, 401)
    let input
    try {
      input = visionConsentSchema.parse(await readVisionJson(request))
    } catch (error) {
      return visionJson(
        { error: "VISION_INVALID_REQUEST" },
        error instanceof Error && error.message === "VISION_BODY_TOO_LARGE"
          ? 413
          : 400,
      )
    }
    const result = await client.rpc("set_vision_consent", {
      p_session_id: input.sessionId,
      p_enabled: input.enabled,
    })
    if (result.error) return visionRpcError(result.error)
    return visionJson({ consentToken: input.enabled ? result.data : null })
  } catch {
    return visionJson({ error: "VISION_UNAVAILABLE" }, 503)
  }
}
