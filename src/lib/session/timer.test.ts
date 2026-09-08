import { describe, expect, it } from "vitest"

import type { StudySession } from "@/lib/domain"
import {
  createRunningCheckpoint,
  createTimerState,
  elapsedSeconds,
  timerReducer,
} from "@/lib/session/timer"

function session(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "session-1",
    user_id: "user-1",
    task_id: "task-1",
    status: "running",
    accumulated_seconds: 120,
    started_at: "2026-08-03T00:00:00.000Z",
    state_version: 0,
    resumed_at: "2026-08-03T00:10:00.000Z",
    ended_at: null,
    camera_enabled: false,
    camera_version: 0,
    reminders_enabled: true,
    experiment_mode: false,
    observation_profile: "study_screen_v1",
    task_outcome: null,
    created_at: "2026-08-03T00:00:00.000Z",
    updated_at: "2026-08-03T00:10:00.000Z",
    ...overrides,
  }
}

describe("study timer", () => {
  it("restores accumulated and currently running time after refresh", () => {
    const state = createTimerState(
      session(),
      new Date("2026-08-03T00:10:45.900Z").getTime(),
    )
    expect(state.mode).toBe("running")
    expect(state.displaySeconds).toBe(165)
  })

  it("does not add wall-clock time while paused", () => {
    const state = createTimerState(
      session({ status: "paused", accumulated_seconds: 321, resumed_at: null }),
      new Date("2026-08-03T08:00:00Z").getTime(),
    )
    expect(
      elapsedSeconds(state, new Date("2026-08-04T08:00:00Z").getTime()),
    ).toBe(321)
  })

  it("checkpoints a hidden running session without counting the same interval twice", () => {
    const hiddenAt = new Date("2026-08-03T00:10:45.900Z").getTime()
    const original = createTimerState(
      session(),
      new Date("2026-08-03T00:10:00Z").getTime(),
    )
    const checkpoint = createRunningCheckpoint(original, hiddenAt)

    expect(checkpoint).toEqual({
      accumulatedSeconds: 165,
      resumedAt: "2026-08-03T00:10:45.000Z",
    })

    const restored = createTimerState(
      session({
        accumulated_seconds: checkpoint!.accumulatedSeconds,
        resumed_at: checkpoint!.resumedAt,
      }),
      new Date("2026-08-03T00:11:00.400Z").getTime(),
    )

    expect(restored.displaySeconds).toBe(180)

    const nextCheckpoint = createRunningCheckpoint(
      restored,
      new Date("2026-08-03T00:11:15.750Z").getTime(),
    )
    expect(nextCheckpoint).toEqual({
      accumulatedSeconds: 195,
      resumedAt: "2026-08-03T00:11:15.000Z",
    })
  })

  it("pauses and resumes without double counting", () => {
    const start = createTimerState(
      session({ accumulated_seconds: 0 }),
      new Date("2026-08-03T00:10:00Z").getTime(),
    )
    const paused = timerReducer(start, {
      type: "pause",
      nowMs: new Date("2026-08-03T00:10:12.400Z").getTime(),
    })
    const resumed = timerReducer(paused, {
      type: "resume",
      nowMs: new Date("2026-08-03T00:20:00Z").getTime(),
    })
    const ticked = timerReducer(resumed, {
      type: "tick",
      nowMs: new Date("2026-08-03T00:20:07.900Z").getTime(),
    })
    expect(ticked.displaySeconds).toBe(20)
  })

  it("freezes elapsed time when a session finishes", () => {
    const start = createTimerState(
      session({ accumulated_seconds: 30 }),
      new Date("2026-08-03T00:10:00Z").getTime(),
    )
    const finished = timerReducer(start, {
      type: "finish",
      nowMs: new Date("2026-08-03T00:10:05Z").getTime(),
    })
    expect(finished.mode).toBe("finished")
    expect(
      elapsedSeconds(finished, new Date("2026-08-03T00:20:00Z").getTime()),
    ).toBe(35)
  })
})
