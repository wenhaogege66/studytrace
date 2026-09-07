import { describe, expect, it } from "vitest"

import {
  DEFAULT_OBSERVATION_PROFILE,
  getObservationProfile,
  parseObservationProfile,
} from "@/lib/vision/profiles"

describe("observation profiles", () => {
  it("uses the safe default for unknown persisted values", () => {
    expect(parseObservationProfile("made-up-profile")).toBe(
      DEFAULT_OBSERVATION_PROFILE,
    )
  })

  it("does not treat normal paper-study head-down posture as a signal", () => {
    expect(getObservationProfile("study_paper_v1").policy.pitch).toBe(false)
    expect(getObservationProfile("study_paper_v1").policy.yaw).toBe(true)
    expect(getObservationProfile("study_paper_v1").faceAbsentMultiplier).toBe(2)
  })

  it("never requests a camera for off-device tasks", () => {
    const profile = getObservationProfile("off_device_v1")
    expect(profile.cameraEnabled).toBe(false)
    expect(Object.values(profile.policy).every((enabled) => !enabled)).toBe(
      true,
    )
  })
})
