import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), fetch: vi.fn() }))
vi.mock("@/lib/privacy/consents", () => ({
  getMyConsents: mocks.get,
  setMyConsent: mocks.set,
  hasConsent: (consents: Record<string, unknown> | undefined) =>
    consents?.cloud_observation === true,
}))
vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test", user: { id: "user-a" } } },
      }),
    },
  }),
}))
import { CloudObservation } from "@/components/session/cloud-observation"
describe("explicit cloud consent and upload lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mocks.get.mockResolvedValue({})
    mocks.set.mockResolvedValue({ cloud_observation: true })
    vi.stubGlobal("fetch", mocks.fetch)
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,YWJj",
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  function props() {
    const video = document.createElement("video")
    video.dataset.sessionId = crypto.randomUUID()
    Object.defineProperty(video, "readyState", { value: 2 })
    const lastValidAtRef = {
      get current() {
        return Date.now()
      },
    }
    return {
      active: true,
      userId: "user-a",
      experimentMode: false,
      agreement: {
        phone: "restricted" as const,
        tablet: "ignored" as const,
        absenceSeconds: 60,
        screenDirection: false,
      },
      videoRef: { current: video },
      lastValidAtRef,
      onCandidate: vi.fn(),
    }
  }
  it("never uploads before a deliberate unchecked-to-checked choice", async () => {
    render(<CloudObservation {...props()} />)
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    await act(async () => vi.advanceTimersByTimeAsync(60000))
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.set).not.toHaveBeenCalled()
  })
  it("sends four frames spanning six seconds, one in flight, and aborts on pause", async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    const input = props()
    const view = render(<CloudObservation {...input} />)
    await act(async () => fireEvent.click(screen.getByRole("checkbox")))
    await act(async () => vi.advanceTimersByTimeAsync(20000))
    expect(mocks.set).toHaveBeenCalledWith("cloud_observation", true, "user-a")
    expect(mocks.fetch).toHaveBeenCalledOnce()
    const options = mocks.fetch.mock.calls[0][1]
    const body = JSON.parse(options.body)
    expect(body.frames).toHaveLength(4)
    expect(
      Date.parse(body.frames[3].capturedAt) -
        Date.parse(body.frames[0].capturedAt),
    ).toBe(6000)
    await act(async () => vi.advanceTimersByTimeAsync(40000))
    expect(mocks.fetch).toHaveBeenCalledOnce()
    view.rerender(<CloudObservation {...input} active={false} />)
    expect(options.signal.aborted).toBe(true)
  })
  it("stops immediately before UI unmount or delayed state updates", async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    render(<CloudObservation {...props()} />)
    await act(async () => fireEvent.click(screen.getByRole("checkbox")))
    await act(async () => vi.advanceTimersByTimeAsync(20000))
    const options = mocks.fetch.mock.calls[0][1]
    await act(async () =>
      window.dispatchEvent(new Event("studytrace:observation-stopping")),
    )
    expect(options.signal.aborted).toBe(true)
  })
  it("keeps the twenty-second dispatch cadence with ten-second provider latency", async () => {
    mocks.fetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: async () => ({
                  status: "complete",
                  quality: "good",
                  candidate_event_ids: [],
                }),
              }),
            10000,
          ),
        ),
    )
    render(<CloudObservation {...props()} />)
    await act(async () => fireEvent.click(screen.getByRole("checkbox")))
    await act(async () => vi.advanceTimersByTimeAsync(20000))
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const first = JSON.parse(mocks.fetch.mock.calls[0][1].body),
      second = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(
      Date.parse(second.frames[3].capturedAt) -
        Date.parse(first.frames[3].capturedAt),
    ).toBe(20000)
  })
  it("aborts on a same-user revocation broadcast from another tab", async () => {
    const channels: Array<{
      onmessage: ((event: MessageEvent) => void) | null
    }> = []
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null
        close = vi.fn()
        constructor() {
          channels.push(this)
        }
      },
    )
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    render(<CloudObservation {...props()} />)
    await act(async () => fireEvent.click(screen.getByRole("checkbox")))
    await act(async () => vi.advanceTimersByTimeAsync(20000))
    const options = mocks.fetch.mock.calls[0][1]
    await act(async () =>
      channels[0].onmessage?.({
        data: { userId: "user-a", consents: { cloud_observation: false } },
      } as MessageEvent),
    )
    expect(options.signal.aborted).toBe(true)
    expect(screen.getByRole("checkbox")).not.toBeChecked()
  })
})
