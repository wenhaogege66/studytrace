import { describe, expect, it } from "vitest"

import {
  createDetectorState,
  processObservation,
  type DetectorState,
  type VisionObservation,
  type VisionThresholds,
} from "@/lib/vision/detector"

const config: VisionThresholds = {
  calibrationMs: 1_000,
  faceAbsentMs: 5_000,
  directionHoldMs: 3_000,
  neutralRecoveryMs: 1_000,
  reminderDelayMs: 2_000,
  reminderCooldownMs: 10_000,
  yawDegrees: 25,
  pitchDegrees: 20,
}

function observation(
  timestampMs: number,
  input: Partial<VisionObservation> = {},
): VisionObservation {
  return { timestampMs, facePresent: true, yaw: 2, pitch: 3, ...input }
}

function calibrate() {
  let state = createDetectorState()
  state = processObservation(state, observation(0), config).state
  state = processObservation(
    state,
    observation(500, { yaw: 4, pitch: 5 }),
    config,
  ).state
  const result = processObservation(
    state,
    observation(1_000, { yaw: 3, pitch: 4 }),
    config,
  )
  expect(result.effects[0]?.type).toBe("calibrated")
  return result.state
}

function run(state: DetectorState, frames: VisionObservation[]) {
  const effects = []
  for (const frame of frames) {
    const result = processObservation(state, frame, config)
    state = result.state
    effects.push(...result.effects)
  }
  return { state, effects }
}

describe("vision rolling-window detector", () => {
  it("uses a median neutral baseline after calibration", () => {
    const state = calibrate()
    expect(state.calibrated).toBe(true)
    expect(state.baselineYaw).toBe(3)
    expect(state.baselinePitch).toBe(4)
  })

  it("starts face-absent only after five continuous seconds and ends after neutral recovery", () => {
    const calibrated = calibrate()
    const result = run(calibrated, [
      observation(1_100, { facePresent: false, yaw: null, pitch: null }),
      observation(5_900, { facePresent: false, yaw: null, pitch: null }),
      observation(6_100, { facePresent: false, yaw: null, pitch: null }),
      observation(6_300),
      observation(7_300),
    ])
    expect(
      result.effects
        .map((effect) => effect.type)
        .filter((type) => type !== "reminder"),
    ).toEqual(["event_started", "event_ended"])
    expect(result.effects[0]).toMatchObject({
      kind: "face_absent",
      atMs: 1_100,
    })
  })

  it("debounces a yaw change for three seconds", () => {
    const calibrated = calibrate()
    const result = run(calibrated, [
      observation(2_000, { yaw: 31 }),
      observation(4_900, { yaw: 31 }),
      observation(5_000, { yaw: 31 }),
    ])
    expect(result.effects).toContainEqual({
      type: "event_started",
      atMs: 2_000,
      kind: "head_direction_change",
      direction: "right",
    })
  })

  it("emits at most one reminder per event and respects same-kind cooldown", () => {
    let state = calibrate()
    let result = run(state, [
      observation(2_000, { facePresent: false, yaw: null, pitch: null }),
      observation(7_000, { facePresent: false, yaw: null, pitch: null }),
      observation(9_000, { facePresent: false, yaw: null, pitch: null }),
      observation(12_000, { facePresent: false, yaw: null, pitch: null }),
    ])
    expect(
      result.effects.filter((effect) => effect.type === "reminder"),
    ).toHaveLength(1)

    state = result.state
    result = run(state, [observation(12_100), observation(13_100)])
    state = result.state
    result = run(state, [
      observation(14_000, { facePresent: false, yaw: null, pitch: null }),
      observation(19_000, { facePresent: false, yaw: null, pitch: null }),
      observation(21_000, { facePresent: false, yaw: null, pitch: null }),
    ])
    expect(
      result.effects.filter((effect) => effect.type === "reminder"),
    ).toHaveLength(1)
  })

  it("resets a candidate when the signal disappears before the threshold", () => {
    const result = run(calibrate(), [
      observation(2_000, { facePresent: false, yaw: null, pitch: null }),
      observation(6_000),
      observation(8_000, { facePresent: false, yaw: null, pitch: null }),
      observation(12_500, { facePresent: false, yaw: null, pitch: null }),
    ])
    expect(
      result.effects.some((effect) => effect.type === "event_started"),
    ).toBe(false)
  })
})
