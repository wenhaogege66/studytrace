import {
  readVisionJson,
  visionObserveSchema,
  visualObservationSchema,
} from "@/lib/ai/vision-observation-contract"
import { decodeVisionImage } from "@/lib/ai/vision-image"
import {
  authenticatedVisionClient,
  visionJson,
  visionRpcError,
} from "../shared"
import { generateVisualObservation } from "@/lib/ai/vision-observation"
import { mapBehaviorEvent, parseTaskSteps } from "@/lib/domain"
import { parseObservationProfile } from "@/lib/vision/profiles"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 20

export async function POST(request: Request) {
  try {
    const client = await authenticatedVisionClient(request)
    if (!client) return visionJson({ error: "VISION_AUTH_REQUIRED" }, 401)
    let input
    try {
      input = visionObserveSchema.parse(await readVisionJson(request))
      await decodeVisionImage(input.image)
    } catch (error) {
      return visionJson(
        { error: "VISION_INVALID_REQUEST" },
        error instanceof Error && error.message === "VISION_BODY_TOO_LARGE"
          ? 413
          : 400,
      )
    }
    const reservation = await client.rpc("reserve_vision_observation", {
      p_session_id: input.sessionId,
      p_consent_token: input.consentToken,
    })
    if (reservation.error) return visionRpcError(reservation.error)
    const context = reservation.data?.[0]
    if (!context) return visionJson({ error: "VISION_QUOTA_EXCEEDED" }, 429)
    try {
      const observation = visualObservationSchema.parse(
        await generateVisualObservation(
          {
            image: input.image,
            title: context.title,
            steps: parseTaskSteps(context.steps),
            observationProfile: parseObservationProfile(
              context.observation_profile,
            ),
          },
          request.signal,
        ),
      )
      if (request.signal.aborted)
        return visionJson({ error: "VISION_REQUEST_ABORTED" }, 409)
      const saved = await client.rpc("save_vision_observation", {
        p_session_id: input.sessionId,
        p_consent_token: input.consentToken,
        p_request_id: context.request_id,
        p_observation: observation,
      })
      if (saved.error) return visionRpcError(saved.error)
      if (!saved.data)
        return visionJson({ error: "VISION_RESULT_EXPIRED" }, 409)
      return visionJson({ event: mapBehaviorEvent(saved.data) })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AI_TimeoutError")
      )
        return visionJson({ error: "VISION_TIMEOUT" }, 504)
      if (
        error instanceof Error &&
        (error.message === "QWEN_NOT_CONFIGURED" ||
          error.message === "QWEN_INVALID_BASE_URL")
      )
        return visionJson({ error: "VISION_UNAVAILABLE" }, 503)
      return visionJson({ error: "VISION_PROVIDER_FAILED" }, 502)
    }
  } catch {
    return visionJson({ error: "VISION_UNAVAILABLE" }, 503)
  }
}
