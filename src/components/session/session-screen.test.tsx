import { act, render } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import type { StudySession, Task } from "@/lib/domain"

const state = vi.hoisted(() => ({
  session: {} as StudySession,
  task: {} as Task,
  camera: vi.fn(),
  onCamera: (() => Promise.resolve(false)) as (
    enabled: boolean,
  ) => Promise<boolean>,
}))
vi.mock("next/dynamic", () => ({
  default: () => (props: { onCameraStateChange: typeof state.onCamera }) => {
    state.onCamera = props.onCameraStateChange
    return null
  },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/hooks/use-study-data", () => ({
  useSession: () => ({ data: state.session }),
  useTask: () => ({ data: state.task }),
  useBehaviorEvents: () => ({ data: [] }),
  useSettings: () => ({ data: undefined }),
  useEventMutations: () => ({}),
  useTaskMutations: () => ({}),
  useSessionMutations: () => ({
    camera: { mutateAsync: state.camera },
    pause: { mutateAsync: vi.fn().mockResolvedValue(state.session) },
    resume: {},
    checkpoint: {},
  }),
}))
import { SessionScreen } from "./session-screen"

beforeEach(() => {
  state.camera.mockReset()
  state.session = {
    id: "session-1",
    user_id: "user-1",
    task_id: "task-1",
    status: "running",
    state_version: 3,
    camera_version: 0,
    camera_enabled: false,
    accumulated_seconds: 0,
    started_at: new Date().toISOString(),
    resumed_at: new Date().toISOString(),
    ended_at: null,
    task_outcome: null,
    experiment_mode: false,
    reminders_enabled: true,
    observation_profile: "study_screen_v1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  state.task = {
    id: "task-1",
    user_id: "user-1",
    title: "Read material",
    priority: "medium",
    estimated_minutes: 20,
    status: "in_progress",
    observation_profile: "study_screen_v1",
    steps: [{ id: "step-1", title: "Read", completed: false }],
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
})

it("accepts only a persisted running camera and uses the current RPC versions", async () => {
  render(<SessionScreen sessionId="session-1" />)
  state.camera.mockResolvedValue({
    ...state.session,
    camera_enabled: true,
    camera_version: 1,
  })
  await expect(state.onCamera(true)).resolves.toBe(true)
  expect(state.camera).toHaveBeenCalledWith({
    sessionId: "session-1",
    expectedStateVersion: 3,
    cameraVersion: 1,
    enabled: true,
  })
  state.camera.mockResolvedValue({
    ...state.session,
    camera_enabled: false,
    camera_version: 2,
  })
  await expect(state.onCamera(true)).resolves.toBe(false)
})

it("rejects a late camera save from before a session generation change", async () => {
  const mounted = render(<SessionScreen sessionId="session-1" />)
  let resolve!: (saved: StudySession) => void
  state.camera.mockReturnValue(
    new Promise<StudySession>((done) => {
      resolve = done
    }),
  )
  const oldSession = state.session
  const ready = state.onCamera(true)
  state.session = {
    ...oldSession,
    status: "paused",
    state_version: 4,
    camera_version: 1,
  }
  mounted.rerender(<SessionScreen sessionId="session-1" />)
  await act(async () =>
    resolve({ ...oldSession, camera_enabled: true, camera_version: 1 }),
  )
  await expect(ready).resolves.toBe(false)
})
