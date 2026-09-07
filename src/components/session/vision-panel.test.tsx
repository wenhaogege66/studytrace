import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mutations = vi.hoisted(() => ({
  create: vi.fn(),
  reminder: vi.fn(),
  update: vi.fn(),
}))

vi.mock("@/hooks/use-study-data", () => ({
  useEventMutations: () => ({
    create: { mutateAsync: mutations.create },
    reminder: { mutateAsync: mutations.reminder },
    update: { mutateAsync: mutations.update },
  }),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  }),
}))

import {
  VISION_MODEL_INIT_TIMEOUT_MS,
  VisionPanel,
} from "@/components/session/vision-panel"

type WorkerListener = (event: MessageEvent) => void

class TestWorker {
  static instances: TestWorker[] = []

  listeners: WorkerListener[] = []
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    TestWorker.instances.push(this)
  }

  addEventListener(_type: string, listener: WorkerListener) {
    this.listeners.push(listener)
  }

  emit(data: unknown) {
    const event = { data } as MessageEvent
    this.listeners.forEach((listener) => listener(event))
  }
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
)

function renderPanel(onCameraStateChange = vi.fn()) {
  render(
    <VisionPanel
      sessionId="session-1"
      paused={false}
      experimentMode={false}
      observationProfile="study_screen_v1"
      onCameraStateChange={onCameraStateChange}
    />,
  )
  return onCameraStateChange
}

describe("VisionPanel model initialization cleanup", () => {
  let stopTrack: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    TestWorker.instances = []
    stopTrack = vi.fn()

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    })
    vi.stubGlobal("Worker", TestWorker)
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
    mutations.create.mockResolvedValue({ id: "event-1" })
    mutations.update.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (originalMediaDevices)
      Object.defineProperty(navigator, "mediaDevices", originalMediaDevices)
    else delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices
  })

  it("lets the user cancel while the local model is loading", async () => {
    const onCameraStateChange = renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})

    const worker = TestWorker.instances[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "init" })
    fireEvent.click(screen.getByRole("button", { name: "取消并关闭" }))
    await act(async () => {})

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(onCameraStateChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole("button", { name: "开启本地观察" })).toBeEnabled()
  })

  it("times out model initialization and releases the camera and worker", async () => {
    const onCameraStateChange = renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})
    const worker = TestWorker.instances[0]

    await act(async () => {
      vi.advanceTimersByTime(VISION_MODEL_INIT_TIMEOUT_MS)
    })

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(onCameraStateChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText(/视觉模型加载超时/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "开启本地观察" })).toBeEnabled()
  })

  it("waits for a real face before running the complete calibration window", async () => {
    renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})
    const worker = TestWorker.instances[0]
    await act(async () => worker.emit({ type: "ready" }))

    expect(screen.getByText("等待进入画面")).toBeInTheDocument()
    expect(screen.getByText("尚未开始")).toBeInTheDocument()

    await act(async () =>
      worker.emit({
        type: "observation",
        observation: {
          timestampMs: 0,
          facePresent: false,
          yaw: null,
          pitch: null,
        },
      }),
    )
    await act(async () =>
      worker.emit({
        type: "observation",
        observation: {
          timestampMs: 5_000,
          facePresent: false,
          yaw: null,
          pitch: null,
        },
      }),
    )

    expect(mutations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "face_absent",
        startedAt: new Date(0).toISOString(),
      }),
    )
    expect(screen.getByText("等待进入画面")).toBeInTheDocument()
    expect(screen.getByText("尚未开始")).toBeInTheDocument()

    await act(async () =>
      worker.emit({
        type: "observation",
        observation: {
          timestampMs: 6_000,
          facePresent: true,
          yaw: 4,
          pitch: 5,
        },
      }),
    )
    expect(screen.getByText("中性姿态校准")).toBeInTheDocument()
    expect(screen.getByText("0%")).toBeInTheDocument()

    await act(async () =>
      worker.emit({
        type: "observation",
        observation: {
          timestampMs: 8_999,
          facePresent: true,
          yaw: 5,
          pitch: 6,
        },
      }),
    )
    expect(screen.getByText("99%")).toBeInTheDocument()
    expect(screen.queryByText(/基线已建立/)).not.toBeInTheDocument()

    await act(async () =>
      worker.emit({
        type: "observation",
        observation: {
          timestampMs: 9_000,
          facePresent: true,
          yaw: 6,
          pitch: 7,
        },
      }),
    )
    expect(screen.getByText(/基线已建立/)).toBeInTheDocument()
  })

  it("retains an open event after failed closure attempts and retries it later", async () => {
    mutations.update.mockRejectedValue(new Error("offline"))
    renderPanel()

    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})
    const worker = TestWorker.instances[0]
    await act(async () => worker.emit({ type: "ready" }))
    for (const timestampMs of [0, 1_500, 3_000]) {
      await act(async () =>
        worker.emit({
          type: "observation",
          observation: {
            timestampMs,
            facePresent: true,
            yaw: 2,
            pitch: 3,
          },
        }),
      )
    }
    for (const timestampMs of [3_100, 8_100]) {
      await act(async () =>
        worker.emit({
          type: "observation",
          observation: {
            timestampMs,
            facePresent: false,
            yaw: null,
            pitch: null,
          },
        }),
      )
    }
    expect(mutations.create).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole("button", { name: "关闭摄像头" }))
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(150)
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(mutations.update).toHaveBeenCalledTimes(3)
    const originalEndAt = mutations.update.mock.calls[0][0].update.ended_at
    expect(
      mutations.update.mock.calls
        .slice(0, 3)
        .map(([input]) => input.update.ended_at),
    ).toEqual([originalEndAt, originalEndAt, originalEndAt])

    mutations.update.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "取消并关闭" }))
    await act(async () => {})

    expect(mutations.update).toHaveBeenCalledTimes(4)
    expect(mutations.update.mock.calls[3][0]).toEqual({
      eventId: "event-1",
      update: { ended_at: originalEndAt },
    })
  })

  it("closes an active event only once when pausing triggers repeated renders", async () => {
    const { rerender } = render(
      <VisionPanel
        sessionId="session-1"
        paused={false}
        experimentMode={false}
        observationProfile="study_screen_v1"
        onCameraStateChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})
    const worker = TestWorker.instances[0]
    await act(async () => worker.emit({ type: "ready" }))

    for (const timestampMs of [0, 1_500, 3_000]) {
      await act(async () =>
        worker.emit({
          type: "observation",
          observation: {
            timestampMs,
            facePresent: true,
            yaw: 2,
            pitch: 3,
          },
        }),
      )
    }
    for (const timestampMs of [3_100, 8_100]) {
      await act(async () =>
        worker.emit({
          type: "observation",
          observation: {
            timestampMs,
            facePresent: false,
            yaw: null,
            pitch: null,
          },
        }),
      )
    }
    expect(mutations.create).toHaveBeenCalledOnce()

    const pausedPanel = (
      <VisionPanel
        sessionId="session-1"
        paused
        experimentMode={false}
        observationProfile="study_screen_v1"
        onCameraStateChange={vi.fn()}
      />
    )
    rerender(pausedPanel)
    rerender(pausedPanel)
    await act(async () => {})

    expect(mutations.update).toHaveBeenCalledOnce()
    expect(stopTrack).toHaveBeenCalledOnce()
  })
})
