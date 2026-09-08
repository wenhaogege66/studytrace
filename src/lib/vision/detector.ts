import type { BehaviorEventType, EventDirection } from "@/lib/domain"
import type { VisionDetectionPolicy } from "@/lib/vision/profiles"

export type VisionObservation = {
  timestampMs: number
  facePresent: boolean
  yaw: number | null
  pitch: number | null
}

export type VisionThresholds = {
  calibrationMs: number
  faceAbsentMs: number
  directionHoldMs: number
  neutralRecoveryMs: number
  reminderDelayMs: number
  reminderCooldownMs: number
  yawDegrees: number
  pitchDegrees: number
}

export type DetectionKind = Exclude<BehaviorEventType, "manual">

export type DetectionSignal = {
  kind: DetectionKind
  direction: EventDirection | null
}

type Candidate = DetectionSignal & { sinceMs: number }
type ActiveDetection = DetectionSignal & {
  startedAtMs: number
  neutralSinceMs: number | null
  reminded: boolean
}

export type DetectorState = {
  calibrationStartedAtMs: number | null
  calibrationYaw: number[]
  calibrationPitch: number[]
  calibrated: boolean
  baselineYaw: number
  baselinePitch: number
  candidate: Candidate | null
  active: ActiveDetection | null
  lastReminderAt: Partial<Record<DetectionKind, number>>
}

export type DetectorEffect =
  | {
      type: "calibrated"
      atMs: number
      baselineYaw: number
      baselinePitch: number
    }
  | {
      type: "event_started"
      atMs: number
      kind: DetectionKind
      direction: EventDirection | null
    }
  | {
      type: "event_ended"
      atMs: number
      kind: DetectionKind
      direction: EventDirection | null
    }
  | { type: "reminder"; atMs: number; kind: DetectionKind }

export const DEFAULT_THRESHOLDS: VisionThresholds = {
  calibrationMs: 3_000,
  faceAbsentMs: 5_000,
  directionHoldMs: 3_000,
  neutralRecoveryMs: 1_000,
  reminderDelayMs: 15_000,
  reminderCooldownMs: 600_000,
  yawDegrees: 25,
  pitchDegrees: 20,
}

export const EXPERIMENT_THRESHOLDS: VisionThresholds = {
  calibrationMs: 1_000,
  faceAbsentMs: 2_000,
  directionHoldMs: 1_200,
  neutralRecoveryMs: 600,
  reminderDelayMs: 3_000,
  reminderCooldownMs: 30_000,
  yawDegrees: 18,
  pitchDegrees: 15,
}

export const DEFAULT_DETECTION_POLICY: VisionDetectionPolicy = {
  faceAbsent: true,
  yaw: true,
  pitch: true,
}

export function createDetectorState(): DetectorState {
  return {
    calibrationStartedAtMs: null,
    calibrationYaw: [],
    calibrationPitch: [],
    calibrated: false,
    baselineYaw: 0,
    baselinePitch: 0,
    candidate: null,
    active: null,
    lastReminderAt: {},
  }
}

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function classify(
  state: DetectorState,
  observation: VisionObservation,
  config: VisionThresholds,
  policy: VisionDetectionPolicy,
): DetectionSignal | null {
  if (!observation.facePresent)
    return policy.faceAbsent ? { kind: "face_absent", direction: null } : null
  if (observation.yaw === null || observation.pitch === null) return null

  const yawDelta = observation.yaw - state.baselineYaw
  const pitchDelta = observation.pitch - state.baselinePitch
  if (policy.yaw && Math.abs(yawDelta) >= config.yawDegrees) {
    return {
      kind: "head_direction_change",
      direction: yawDelta > 0 ? "right" : "left",
    }
  }
  if (policy.pitch && pitchDelta >= config.pitchDegrees)
    return { kind: "head_direction_change", direction: "down" }
  return null
}

function sameSignal(
  left: DetectionSignal | null,
  right: DetectionSignal | null,
) {
  return left?.kind === right?.kind && left?.direction === right?.direction
}

function applySignal(
  state: DetectorState,
  signal: DetectionSignal | null,
  timestampMs: number,
  config: VisionThresholds,
  effects: DetectorEffect[],
) {
  if (state.active) {
    if (sameSignal(state.active, signal)) {
      state.active.neutralSinceMs = null
    } else if (signal === null) {
      state.active.neutralSinceMs ??= timestampMs
      if (
        timestampMs - state.active.neutralSinceMs >=
        config.neutralRecoveryMs
      ) {
        effects.push({
          type: "event_ended",
          atMs: timestampMs,
          kind: state.active.kind,
          direction: state.active.direction,
        })
        state.active = null
        state.candidate = null
      }
    } else {
      effects.push({
        type: "event_ended",
        atMs: timestampMs,
        kind: state.active.kind,
        direction: state.active.direction,
      })
      state.active = null
      state.candidate = { ...signal, sinceMs: timestampMs }
    }

    if (
      state.active &&
      !state.active.reminded &&
      timestampMs - state.active.startedAtMs >= config.reminderDelayMs
    ) {
      const lastReminder =
        state.lastReminderAt[state.active.kind] ?? Number.NEGATIVE_INFINITY
      if (timestampMs - lastReminder >= config.reminderCooldownMs) {
        state.active.reminded = true
        state.lastReminderAt[state.active.kind] = timestampMs
        effects.push({
          type: "reminder",
          atMs: timestampMs,
          kind: state.active.kind,
        })
      }
    }
    return
  }

  if (!signal) {
    state.candidate = null
    return
  }

  if (!sameSignal(state.candidate, signal)) {
    state.candidate = { ...signal, sinceMs: timestampMs }
    return
  }

  const requiredDuration =
    signal.kind === "face_absent" ? config.faceAbsentMs : config.directionHoldMs
  if (
    state.candidate &&
    timestampMs - state.candidate.sinceMs >= requiredDuration
  ) {
    state.active = {
      kind: signal.kind,
      direction: signal.direction,
      startedAtMs: state.candidate.sinceMs,
      neutralSinceMs: null,
      reminded: false,
    }
    effects.push({
      type: "event_started",
      atMs: state.candidate.sinceMs,
      kind: signal.kind,
      direction: signal.direction,
    })
    state.candidate = null
  }
}

export function processObservation(
  previous: DetectorState,
  observation: VisionObservation,
  config: VisionThresholds = DEFAULT_THRESHOLDS,
  policy: VisionDetectionPolicy = DEFAULT_DETECTION_POLICY,
): { state: DetectorState; effects: DetectorEffect[] } {
  const state: DetectorState = {
    ...previous,
    calibrationYaw: [...previous.calibrationYaw],
    calibrationPitch: [...previous.calibrationPitch],
    lastReminderAt: { ...previous.lastReminderAt },
    candidate: previous.candidate ? { ...previous.candidate } : null,
    active: previous.active ? { ...previous.active } : null,
  }
  const effects: DetectorEffect[] = []

  if (!state.calibrated) {
    const hasValidPose =
      observation.facePresent &&
      observation.yaw !== null &&
      observation.pitch !== null
    const preCalibrationSignal =
      !observation.facePresent && policy.faceAbsent
        ? { kind: "face_absent" as const, direction: null }
        : null
    applySignal(
      state,
      preCalibrationSignal,
      observation.timestampMs,
      config,
      effects,
    )

    if (!hasValidPose) {
      state.calibrationStartedAtMs = null
      state.calibrationYaw = []
      state.calibrationPitch = []
      return { state, effects }
    }

    state.calibrationStartedAtMs ??= observation.timestampMs
    state.calibrationYaw.push(observation.yaw as number)
    state.calibrationPitch.push(observation.pitch as number)

    if (
      observation.timestampMs - state.calibrationStartedAtMs >=
        config.calibrationMs &&
      state.calibrationYaw.length >= 2
    ) {
      state.baselineYaw = median(state.calibrationYaw)
      state.baselinePitch = median(state.calibrationPitch)
      state.calibrated = true
      effects.push({
        type: "calibrated",
        atMs: observation.timestampMs,
        baselineYaw: state.baselineYaw,
        baselinePitch: state.baselinePitch,
      })
    }
    return { state, effects }
  }

  const signal = classify(state, observation, config, policy)
  applySignal(state, signal, observation.timestampMs, config, effects)

  return { state, effects }
}
