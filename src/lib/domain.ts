import type { Json, Tables } from "@/types/database"
import {
  parseObservationProfile,
  type ObservationProfile,
} from "@/lib/vision/profiles"

export type Priority = "low" | "medium" | "high"
export type TaskStatus = "planned" | "in_progress" | "completed" | "archived"
export type SessionStatus = "running" | "paused" | "completed" | "cancelled"
export type BehaviorEventType =
  "face_absent" | "head_direction_change" | "manual"
export type EventDirection = "left" | "right" | "down" | "unknown"
export type EventSource = "vision" | "simulation" | "manual"
export type CompletionStatus =
  "completed" | "partially_completed" | "not_completed"
export type SessionOutcome = CompletionStatus

export type TaskStep = {
  id: string
  title: string
  completed: boolean
}

export type Task = Omit<Tables<"tasks">, "steps" | "priority" | "status"> & {
  steps: TaskStep[]
  priority: Priority
  status: TaskStatus
  observation_profile: ObservationProfile
}

export type StudySession = Omit<
  Tables<"study_sessions">,
  "status" | "task_outcome" | "observation_profile"
> & {
  status: SessionStatus
  task_outcome: SessionOutcome | null
  observation_profile: ObservationProfile
}

export type BehaviorEvent = Omit<
  Tables<"behavior_events">,
  "event_type" | "direction" | "source"
> & {
  event_type: BehaviorEventType
  direction: EventDirection | null
  source: EventSource
}

export type Review = Omit<Tables<"reviews">, "completion_status"> & {
  completion_status: CompletionStatus
}

export type UserSettings = Tables<"user_settings">

export type TaskDraft = {
  title: string
  steps: TaskStep[]
  priority: Priority
  estimatedMinutes: number
  observationProfile: ObservationProfile
}

export function createStep(title: string): TaskStep {
  return {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
  }
}

export function parseTaskSteps(value: Json): TaskStep[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return []
    const title = typeof item.title === "string" ? item.title.trim() : ""
    if (!title) return []

    return [
      {
        id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
        title,
        completed: item.completed === true,
      },
    ]
  })
}

export function mapTask(row: Tables<"tasks">): Task {
  return {
    ...row,
    priority: row.priority as Priority,
    status: row.status as TaskStatus,
    steps: parseTaskSteps(row.steps),
    observation_profile: parseObservationProfile(row.observation_profile),
  }
}

export function mapSession(row: Tables<"study_sessions">): StudySession {
  return {
    ...row,
    status: row.status as SessionStatus,
    task_outcome: row.task_outcome as SessionOutcome | null,
    observation_profile: parseObservationProfile(row.observation_profile),
  }
}

export function canStartTask(status: TaskStatus) {
  return status === "planned" || status === "in_progress"
}

export function areTaskStepsComplete(steps: TaskStep[]) {
  return steps.length > 0 && steps.every((step) => step.completed)
}

export function taskStatusForOutcome(outcome: SessionOutcome): TaskStatus {
  return outcome === "completed" ? "completed" : "in_progress"
}

export function mapBehaviorEvent(
  row: Tables<"behavior_events">,
): BehaviorEvent {
  return {
    ...row,
    event_type: row.event_type as BehaviorEventType,
    direction: row.direction as EventDirection | null,
    source: row.source as EventSource,
  }
}

export function mapReview(row: Tables<"reviews">): Review {
  return {
    ...row,
    completion_status: row.completion_status as CompletionStatus,
  }
}

export function stepsToJson(steps: TaskStep[]): Json {
  return steps.map(({ id, title, completed }) => ({ id, title, completed }))
}

export function formatDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  if (hours > 0)
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

export function formatMinutes(totalSeconds: number) {
  if (totalSeconds < 60) return "不足 1 分钟"
  return `${Math.round(totalSeconds / 60)} 分钟`
}
