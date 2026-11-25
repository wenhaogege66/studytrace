import { z } from "zod"

export const visualObservationSchema = z
  .object({
    signal: z.enum([
      "reading",
      "writing",
      "device_interaction",
      "looking_away",
      "absent",
      "unknown",
    ]),
    taskRelevance: z.enum(["related", "unrelated", "uncertain"]),
    summary: z.string().trim().min(1).max(160),
  })
  .strict()

export type VisualObservation = z.infer<typeof visualObservationSchema>
export const visionConsentSchema = z.object({
  sessionId: z.uuid(),
  enabled: z.boolean(),
})
export const visionObserveSchema = z.object({
  sessionId: z.uuid(),
  consentToken: z.uuid(),
  image: z.string(),
})

export async function readVisionJson(request: Request): Promise<unknown> {
  const limit = 360 * 1024
  const declared = request.headers.get("content-length")
  if (declared && Number(declared) > limit)
    throw new Error("VISION_BODY_TOO_LARGE")
  const reader = request.body?.getReader()
  if (!reader) throw new Error("VISION_INVALID_BODY")
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error("VISION_BODY_TOO_LARGE")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
