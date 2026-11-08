import { describe, expect, it } from "vitest"
import {
  cloudRequestSchema,
  consecutiveCloudCandidate,
} from "@/lib/vision/cloud-contract"
describe("cloud observation windows", () => {
  const possible = {
    quality: "good",
    phone: "possible",
    tablet: "unknown",
  } as const
  it("needs two adjacent valid windows; unknown and gaps break continuity", () => {
    expect(
      consecutiveCloudCandidate(
        { at: 0, result: possible },
        { at: 20_000, result: possible },
        "phone",
      ),
    ).toBe(true)
    expect(
      consecutiveCloudCandidate(
        { at: 0, result: possible },
        { at: 60_000, result: possible },
        "phone",
      ),
    ).toBe(false)
    expect(
      consecutiveCloudCandidate(
        { at: 0, result: { ...possible, quality: "unknown" } },
        { at: 20_000, result: possible },
        "phone",
      ),
    ).toBe(false)
    expect(
      consecutiveCloudCandidate(
        null,
        { at: 20_000, result: possible },
        "phone",
      ),
    ).toBe(false)
  })
  it("rejects remote URLs, oversized frames and sparse frame sequences", () => {
    const base = {
      sessionId: crypto.randomUUID(),
      windowId: crypto.randomUUID(),
      frames: [0, 2, 4, 6].map((sec) => ({
        capturedAt: new Date(100000 + sec * 1000).toISOString(),
        image: "data:image/jpeg;base64,YWJj",
      })),
    }
    expect(cloudRequestSchema.safeParse(base).success).toBe(true)
    expect(
      cloudRequestSchema.safeParse({
        ...base,
        frames: base.frames.map((frame) => ({
          ...frame,
          image: "https://example.com/image.jpg",
        })),
      }).success,
    ).toBe(false)
    expect(
      cloudRequestSchema.safeParse({
        ...base,
        frames: base.frames.map((frame, i) => ({
          ...frame,
          capturedAt: new Date(100000 + i * 5000).toISOString(),
        })),
      }).success,
    ).toBe(false)
  })
})
