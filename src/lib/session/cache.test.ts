import { describe, expect, it } from "vitest"

import type { StudySession } from "@/lib/domain"
import {
  mergeActiveMutationSnapshot,
  mergeSessionSnapshot,
} from "@/lib/session/cache"

function session(overrides: Partial<StudySession> = {}): StudySession {
  return {
    id: "session-a",
    user_id: "user-1",
    task_id: "task-1",
    status: "running",
    accumulated_seconds: 0,
    started_at: "2026-09-07T00:00:00.000Z",
    resumed_at: "2026-09-07T00:00:00.000Z",
    ended_at: null,
    camera_enabled: false,
    reminders_enabled: true,
    experiment_mode: false,
    observation_profile: "study_screen_v1",
    task_outcome: null,
    state_version: 0,
    camera_version: 0,
    created_at: "2026-09-07T00:00:00.000Z",
    updated_at: "2026-09-07T00:00:00.000Z",
    ...overrides,
  }
}

describe("study session cache ordering", () => {
  it("does not let a stale running query replace a newer paused generation", () => {
    const paused = session({
      status: "paused",
      resumed_at: null,
      state_version: 1,
      updated_at: "2026-09-07T00:01:00.000Z",
    })
    const staleRunning = session()

    expect(mergeSessionSnapshot(paused, staleRunning)).toBe(paused)
  })

  it("does not let a late terminal response clear a different active session", () => {
    const activeB = session({
      id: "session-b",
      task_id: "task-2",
      created_at: "2026-09-07T01:00:00.000Z",
      updated_at: "2026-09-07T01:00:00.000Z",
    })
    const lateTerminalA = session({
      status: "cancelled",
      resumed_at: null,
      ended_at: "2026-09-07T00:30:00.000Z",
      state_version: 1,
      updated_at: "2026-09-07T00:30:00.000Z",
    })

    expect(mergeActiveMutationSnapshot(activeB, lateTerminalA)).toEqual({
      value: activeB,
      conflict: true,
    })
  })

  it("prefers a newer camera intent even when its transaction timestamp is older", () => {
    const cameraV1 = session({
      camera_enabled: true,
      camera_version: 1,
      updated_at: "2026-09-07T00:02:00.000Z",
    })
    const cameraV2 = session({
      camera_enabled: false,
      camera_version: 2,
      updated_at: "2026-09-07T00:01:00.000Z",
    })

    expect(mergeSessionSnapshot(cameraV1, cameraV2)).toBe(cameraV2)
  })
})
