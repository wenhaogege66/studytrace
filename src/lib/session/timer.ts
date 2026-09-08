import type { SessionStatus, StudySession } from "@/lib/domain"

export type TimerMode = "running" | "paused" | "finished"

export type TimerState = {
  mode: TimerMode
  accumulatedMs: number
  anchorMs: number | null
  displaySeconds: number
}

export type TimerAction =
  | { type: "tick"; nowMs: number }
  | { type: "pause"; nowMs: number }
  | { type: "resume"; nowMs: number }
  | { type: "finish"; nowMs: number }
  | { type: "restore"; state: TimerState }

function toMode(status: SessionStatus): TimerMode {
  if (status === "running") return "running"
  if (status === "paused") return "paused"
  return "finished"
}

export function elapsedMs(state: TimerState, nowMs: number) {
  if (state.mode !== "running" || state.anchorMs === null)
    return state.accumulatedMs
  return state.accumulatedMs + Math.max(0, nowMs - state.anchorMs)
}

export function elapsedSeconds(state: TimerState, nowMs: number) {
  return Math.floor(elapsedMs(state, nowMs) / 1000)
}

export function createRunningCheckpoint(state: TimerState, nowMs: number) {
  if (state.mode !== "running") return null

  const totalMs = elapsedMs(state, nowMs)
  const accumulatedSeconds = Math.floor(totalMs / 1_000)
  const remainderMs = totalMs - accumulatedSeconds * 1_000

  return {
    accumulatedSeconds,
    resumedAt: new Date(nowMs - remainderMs).toISOString(),
  }
}

export function createTimerState(
  session: StudySession,
  nowMs = Date.now(),
): TimerState {
  const mode = toMode(session.status)
  const accumulatedMs = session.accumulated_seconds * 1000
  const anchorMs =
    mode === "running"
      ? new Date(session.resumed_at ?? session.started_at).getTime()
      : null
  const state = { mode, accumulatedMs, anchorMs, displaySeconds: 0 }
  return { ...state, displaySeconds: elapsedSeconds(state, nowMs) }
}

export function timerReducer(
  state: TimerState,
  action: TimerAction,
): TimerState {
  switch (action.type) {
    case "tick":
      return { ...state, displaySeconds: elapsedSeconds(state, action.nowMs) }
    case "pause": {
      const accumulatedMs = elapsedMs(state, action.nowMs)
      return {
        mode: "paused",
        accumulatedMs,
        anchorMs: null,
        displaySeconds: Math.floor(accumulatedMs / 1000),
      }
    }
    case "resume":
      if (state.mode === "running") return state
      return { ...state, mode: "running", anchorMs: action.nowMs }
    case "finish": {
      const accumulatedMs = elapsedMs(state, action.nowMs)
      return {
        mode: "finished",
        accumulatedMs,
        anchorMs: null,
        displaySeconds: Math.floor(accumulatedMs / 1000),
      }
    }
    case "restore":
      return action.state
  }
}
