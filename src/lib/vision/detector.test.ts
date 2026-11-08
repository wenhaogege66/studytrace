import { describe, expect, it } from "vitest"
import {
  createDetectorState,
  DEFAULT_THRESHOLDS,
  processObservation,
  type DetectorEffect,
  type DetectorState,
  type VisionObservation,
} from "@/lib/vision/detector"

const config = {
  ...DEFAULT_THRESHOLDS,
  calibrationMs: 1_000,
  faceAbsentMs: 2_000,
  directionHoldMs: 1_000,
  neutralRecoveryMs: 500,
  reminderDelayMs: 3_000,
  reminderCooldownMs: 10_000,
}
const face = (timestampMs: number, yaw = 0, pitch = 0): VisionObservation => ({
  timestampMs,
  facePresent: true,
  yaw,
  pitch,
  valid: true,
})
const absent = (timestampMs: number): VisionObservation => ({
  timestampMs,
  facePresent: false,
  yaw: null,
  pitch: null,
  valid: true,
})
function run(
  state: DetectorState,
  start: number,
  end: number,
  sample: (time: number) => VisionObservation,
) {
  const effects: DetectorEffect[] = []
  for (let time = start; time <= end; time += 250) {
    const next = processObservation(state, sample(time), config)
    state = next.state
    effects.push(...next.effects)
  }
  return { state, effects }
}
function calibrated() {
  const result = run(createDetectorState(), 0, 1_000, face)
  expect(result.state.calibrated).toBe(true)
  return result.state
}
describe("valid local rolling windows", () => {
  it("requires stable dense samples, not elapsed time or two sparse frames", () => {
    let state = processObservation(createDetectorState(), face(0), config).state
    state = processObservation(state, face(3_000), config).state
    expect(state.calibrated).toBe(false)
    const unstable = run(createDetectorState(), 0, 3_000, (time) =>
      face(time, time % 500 ? 30 : 0),
    )
    expect(unstable.state.calibrated).toBe(false)
    expect(calibrated().baselineYaw).toBe(0)
  })
  it("records continuous initial absence without inventing a pose baseline", () => {
    const result = run(createDetectorState(), 0, 2_000, absent)
    expect(result.state.calibrated).toBe(false)
    expect(result.effects).toContainEqual({
      type: "event_started",
      atMs: 0,
      kind: "face_absent",
      direction: null,
    })
  })
  it("debounces absence and requires neutral recovery", () => {
    const observed = run(calibrated(), 1_250, 3_250, absent)
    expect(
      observed.effects.filter((item) => item.type === "event_started"),
    ).toHaveLength(1)
    const recovered = run(observed.state, 3_500, 4_000, face)
    expect(recovered.effects.some((item) => item.type === "event_ended")).toBe(
      true,
    )
  })
  it("debounces direction, respects paper policy and never treats unknown pose as neutral", () => {
    const observed = run(calibrated(), 1_250, 2_250, (time) => face(time, 35))
    expect(observed.state.active?.direction).toBe("right")
    const invalid = processObservation(
      observed.state,
      { ...face(2_500), yaw: null },
      config,
    )
    expect(invalid.state.active).toBeNull()
    expect(invalid.state.validCoverageMs).toBe(observed.state.validCoverageMs)
    const paper = processObservation(calibrated(), face(1_250, 0, 45), config, {
      faceAbsent: true,
      yaw: true,
      pitch: false,
    })
    expect(paper.state.candidate).toBeNull()
  })
  it("resets a streak across frame gaps and closes at the last observed frame", () => {
    const observed = run(calibrated(), 1_250, 2_250, (time) => face(time, 35))
    const gap = processObservation(observed.state, face(9_000, 35), config)
    expect(gap.state.active).toBeNull()
    expect(gap.state.validCoverageMs).toBe(observed.state.validCoverageMs)
    expect(gap.effects).toContainEqual({
      type: "event_ended",
      atMs: 2_250,
      kind: "head_direction_change",
      direction: "right",
    })
  })
  it("accumulates only valid consecutive inference coverage", () => {
    const state = run(createDetectorState(), 0, 1_000, face).state
    expect(state.validCoverageMs).toBe(1_000)
    const failed = processObservation(
      state,
      { ...face(1_250), valid: false },
      config,
    ).state
    const recovered = processObservation(failed, face(5_000), config).state
    expect(recovered.validCoverageMs).toBe(1_000)
    expect(
      processObservation(recovered, face(5_250), config).state.validCoverageMs,
    ).toBe(1_250)
  })
  it("reminds once per event and does not infer reminders through a pause", () => {
    const result = run(calibrated(), 1_250, 8_000, absent)
    expect(
      result.effects.filter((item) => item.type === "reminder"),
    ).toHaveLength(1)
    const gap = processObservation(result.state, absent(20_000), config)
    expect(gap.effects.some((item) => item.type === "reminder")).toBe(false)
  })
})
