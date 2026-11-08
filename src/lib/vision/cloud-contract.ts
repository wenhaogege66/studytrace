import { z } from "zod"

export const cloudResultSchema = z.object({
  quality: z.enum(["good", "unknown"]),
  phone: z.enum(["clear", "possible", "unknown"]),
  tablet: z.enum(["clear", "possible", "unknown"]),
})
export type CloudObservationResult = z.infer<typeof cloudResultSchema>
const jpegSchema = z
  .string()
  .max(180_000)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)
export const cloudRequestSchema = z
  .object({
    sessionId: z.uuid(),
    windowId: z.uuid(),
    frames: z
      .array(z.object({ capturedAt: z.iso.datetime(), image: jpegSchema }))
      .length(4),
  })
  .superRefine((input, context) => {
    const times = input.frames.map((frame) => Date.parse(frame.capturedAt))
    if (
      times.some(
        (time, index) =>
          index > 0 &&
          (time - times[index - 1] < 1_000 || time - times[index - 1] > 3_000),
      ) ||
      times[3] - times[0] < 5_000 ||
      times[3] - times[0] > 8_000
    )
      context.addIssue({ code: "custom", message: "需要连续约六秒的四张图像" })
  })
export type CloudRequest = z.infer<typeof cloudRequestSchema>

// A missing/unknown window is a break, not evidence of continued behavior.
export function consecutiveCloudCandidate(
  previous: { at: number; result: CloudObservationResult } | null,
  current: { at: number; result: CloudObservationResult },
  rule: "phone" | "tablet",
) {
  return (
    previous !== null &&
    current.at - previous.at >= 14_000 &&
    current.at - previous.at <= 28_000 &&
    previous.result.quality === "good" &&
    current.result.quality === "good" &&
    previous.result[rule] === "possible" &&
    current.result[rule] === "possible"
  )
}
