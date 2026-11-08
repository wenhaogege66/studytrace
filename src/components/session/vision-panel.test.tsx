import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mutations = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  reminder: vi.fn(),
  respondReminder: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/hooks/use-study-data", () => ({
  useEventMutations: () => ({
    create: { mutateAsync: mutations.create },
    update: { mutateAsync: mutations.update },
    reminder: { mutateAsync: mutations.reminder },
    respondReminder: { mutateAsync: mutations.respondReminder, isPending: false },
    refresh: mutations.refresh,
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
  VisionPanel,
  VISION_MODEL_INIT_TIMEOUT_MS,
} from "@/components/session/vision-panel"
class TestWorker {
  static instances: TestWorker[] = []
  listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    TestWorker.instances.push(this)
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(data: unknown) {
    this.listeners
      .get("message")
      ?.forEach((listener) => listener({ data } as MessageEvent))
  }
  crash() {
    this.listeners
      .get("error")
      ?.forEach((listener) => listener({} as MessageEvent))
  }
}
const mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")
describe("reliable observation lifecycle", () => {
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
          getVideoTracks: () => [
            { stop: stopTrack, addEventListener: vi.fn() },
          ],
        }),
      },
    })
    vi.stubGlobal("Worker", TestWorker)
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockImplementation(async () => ({ close: vi.fn() })),
    )
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2)
    vi.spyOn(
      HTMLMediaElement.prototype,
      "currentTime",
      "get",
    ).mockImplementation(() => Date.now() / 1000)
    mutations.create.mockResolvedValue({ id: "event" })
    mutations.update.mockResolvedValue({})
    mutations.reminder.mockResolvedValue({})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (mediaDevices)
      Object.defineProperty(navigator, "mediaDevices", mediaDevices)
  })
  function mount() {
    const camera = vi.fn()
    const coverage = vi.fn()
    render(
      <VisionPanel
        sessionId="session-1"
        paused={false}
        experimentMode={false}
        observationProfile="study_screen_v1"
        onCameraStateChange={camera}
        onValidCoverage={coverage}
      />,
    )
    return { camera, coverage }
  }
  async function start() {
    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    await act(async () => {})
    return TestWorker.instances.at(-1)!
  }
  async function frame(worker: TestWorker, valid = true) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    const sent = worker.postMessage.mock.calls
      .map((call) => call[0])
      .filter((call) => call.type === "detect")
      .at(-1)
    if (!sent) throw new Error("no sampled frame")
    await act(async () =>
      worker.emit({
        type: "observation",
        frameId: sent.frameId,
        observation: {
          timestampMs: Date.now(),
          facePresent: true,
          yaw: 0,
          pitch: 0,
          valid,
        },
      }),
    )
  }
  it("bounds worker initialization retries and then releases camera", async () => {
    const { camera } = mount()
    await start()
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VISION_MODEL_INIT_TIMEOUT_MS)
      })
    expect(TestWorker.instances).toHaveLength(3)
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(camera).toHaveBeenLastCalledWith(false)
  })
  it("counts only valid inference frames and ignores stale frame IDs", async () => {
    const { coverage } = mount()
    const worker = await start()
    await act(async () => worker.emit({ type: "ready" }))
    await frame(worker)
    await frame(worker)
    expect(coverage).toHaveBeenCalledOnce()
    const total = coverage.mock.calls[0][0].totalMs
    await frame(worker, false)
    expect(coverage).toHaveBeenCalledOnce()
    await act(async () =>
      worker.emit({
        type: "observation",
        frameId: 1,
        observation: {
          timestampMs: Date.now() + 30000,
          facePresent: true,
          yaw: 0,
          pitch: 0,
          valid: true,
        },
      }),
    )
    expect(coverage.mock.calls[0][0].totalMs).toBe(total)
  })
  it("restarts a crashed worker finitely and ignores old messages", async () => {
    mount()
    const worker = await start()
    await act(async () => worker.emit({ type: "ready" }))
    await act(async () => worker.crash())
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(TestWorker.instances).toHaveLength(2)
    await act(async () => worker.emit({ type: "ready" }))
    expect(screen.getByText(/观察中断，正在重新加载/)).toBeInTheDocument()
  })
  it("covers stalled bitmap creation with the same finite watchdog", async () => {
    vi.mocked(createImageBitmap).mockImplementation(() => new Promise(() => {}))
    mount()
    const worker = await start()
    await act(async () => worker.emit({ type: "ready" }))
    await act(async () => vi.advanceTimersByTimeAsync(2_500))
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(TestWorker.instances).toHaveLength(2)
  })
  it("releases the camera even when the worker message channel is broken", async () => {
    mount()
    const worker = await start()
    await act(async () => worker.emit({ type: "ready" }))
    worker.postMessage.mockImplementation(() => {
      throw new Error("broken-channel")
    })
    fireEvent.click(screen.getByRole("button", { name: "关闭摄像头" }))
    await act(async () => {})
    expect(stopTrack).toHaveBeenCalledOnce()
  })
  it("stops on identity change and never enables cloud without explicit selection", async () => {
    const { camera } = mount()
    await start()
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    await act(async () =>
      window.dispatchEvent(new Event("studytrace:identity-changing")),
    )
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(camera).toHaveBeenLastCalledWith(false)
  })
  it("cancels pending getUserMedia without leaving a late stream alive", async () => {
    let finish!: (stream: MediaStream) => void
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    mount()
    fireEvent.click(screen.getByRole("button", { name: "开启本地观察" }))
    fireEvent.click(screen.getByRole("button", { name: "取消并关闭" }))
    await act(async () =>
      finish({
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream),
    )
    expect(stopTrack).toHaveBeenCalledOnce()
    expect(TestWorker.instances).toHaveLength(0)
  })
})
