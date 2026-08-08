import { describe, expect, it } from "vitest"

import type { StudySession } from "@/lib/domain"
import {
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
    resumed_at: "2026-08-03T00:10:00.000Z",
    ended_at: null,
    camera_enabled: false,
    reminders_enabled: true,
    experiment_mode: false,
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
