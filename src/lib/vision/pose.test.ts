import { describe, expect, it } from "vitest"

import { matrixToPose } from "@/lib/vision/pose"

describe("facial transformation matrix conversion", () => {
  it("returns a neutral pose for the identity matrix", () => {
    expect(
      matrixToPose([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    ).toEqual({ yaw: 0, pitch: -0 })
  })

  it("fails safely for malformed matrix data", () => {
    expect(matrixToPose([1, 2, 3])).toEqual({ yaw: null, pitch: null })
    expect(matrixToPose(Array(16).fill(0))).toEqual({ yaw: null, pitch: null })
    expect(matrixToPose(Array(16).fill(NaN))).toEqual({
      yaw: null,
      pitch: null,
    })
  })
})
