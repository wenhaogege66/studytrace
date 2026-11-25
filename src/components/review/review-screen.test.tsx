import { fireEvent, render, screen, act } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import type { BehaviorEvent } from "@/lib/domain"

const update = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-study-data", () => ({
  useEventMutations: () => ({
    update: { mutateAsync: update, isPending: false },
    remove: { mutateAsync: vi.fn() },
  }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { EventItem } from "./review-screen"

const observation = {
  signal: "unknown",
  taskRelevance: "uncertain",
  summary: "画面不足以判断当前活动",
} as const
const cloud: BehaviorEvent = {
  id: "cloud-1",
  user_id: "user-1",
  session_id: "session-1",
  event_type: "visual_observation",
  source: "cloud_vision",
  direction: null,
  started_at: "2026-11-25T12:00:00Z",
  ended_at: "2026-11-25T12:00:00Z",
  created_at: "2026-11-25T12:00:00Z",
  updated_at: "2026-11-25T12:00:00Z",
  review_status: "pending",
  corrected_type: null,
  corrected_direction: null,
  correction_note: null,
  visual_observation: observation,
}
beforeEach(() => update.mockReset().mockResolvedValue({ ...cloud }))

it("labels cloud snapshots as uncertain, with structured signals and no duration", () => {
  render(<EventItem event={cloud} sessionId="session-1" />)
  expect(screen.getByText("云端观察", { exact: true })).toBeInTheDocument()
  expect(screen.getByText(/信号：无法判断/)).toBeInTheDocument()
  expect(screen.getByText(/任务关联：不确定/)).toBeInTheDocument()
  expect(screen.getByText(observation.summary)).toBeInTheDocument()
  expect(screen.getByText(/单帧线索/)).toBeInTheDocument()
  expect(screen.queryByText(/持续.*秒/)).not.toBeInTheDocument()
})

it("retains the cloud type when correcting a note and sends only review fields", async () => {
  render(<EventItem event={cloud} sessionId="session-1" />)
  fireEvent.click(screen.getByRole("button", { name: "修正" }))
  expect(screen.getByRole("combobox")).toHaveTextContent("保留云端观察")
  fireEvent.change(screen.getByLabelText("修正说明（可选）"), {
    target: { value: " 当时在读书 " },
  })
  fireEvent.click(screen.getByRole("button", { name: "保存修正" }))
  await act(async () => {})
  expect(update).toHaveBeenCalledWith({
    eventId: "cloud-1",
    update: {
      review_status: "corrected",
      corrected_type: "visual_observation",
      corrected_direction: null,
      correction_note: "当时在读书",
    },
  })
  expect(cloud.visual_observation).toEqual(observation)
})

it("keeps original metadata visible after correction to an unrelated event", () => {
  render(
    <EventItem
      event={{
        ...cloud,
        review_status: "corrected",
        corrected_type: "not_relevant",
      }}
      sessionId="session-1"
    />,
  )
  expect(screen.getByText("与本次复盘无关")).toBeInTheDocument()
  expect(screen.getByText(observation.summary)).toBeInTheDocument()
  expect(screen.getByText("云端观察", { exact: true })).toBeInTheDocument()
})
