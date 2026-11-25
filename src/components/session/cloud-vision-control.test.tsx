import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/experience/experience-provider", () => ({
  useExperience: () => ({ user: { id: "user-1" } }),
}))
const auth = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({ auth }),
}))

import { captureCloudFrame, CloudVisionControl } from "./cloud-vision-control"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("cloud camera consent and sampling", () => {
  let requests: {
    path: string
    body: Record<string, unknown>
    signal?: AbortSignal | null
  }[]
  let fetchMock: ReturnType<
    typeof vi.fn<
      (path: string, init: RequestInit) => Promise<Response> | Response
    >
  >
  let capture: ReturnType<typeof vi.fn<() => string | null>>
  let client: QueryClient
  let stopRef: { current: () => void }

  function view(
    cameraActive = true,
    paused = false,
    observationProfile: "study_screen_v1" | "off_device_v1" = "study_screen_v1",
  ) {
    return (
      <QueryClientProvider client={client}>
        <CloudVisionControl
          sessionId="session-1"
          paused={paused}
          observationProfile={observationProfile}
          cameraActive={cameraActive}
          capture={capture}
          stopRef={stopRef}
        />
      </QueryClientProvider>
    )
  }
  async function consent() {
    fireEvent.click(screen.getByRole("button", { name: "开启云端观察" }))
    expect(screen.getByRole("button", { name: "确认开启" })).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "确认开启" }))
    await act(async () => {})
  }
  const observeRequests = () =>
    requests.filter((r) => r.path.endsWith("/observe"))
  const revokes = () => requests.filter((r) => r.body.enabled === false)

  beforeEach(() => {
    vi.useFakeTimers()
    requests = []
    capture = vi.fn().mockReturnValue("data:image/jpeg;base64,/9j/AA==")
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    stopRef = { current: () => {} }
    auth.getSession.mockResolvedValue({
      data: { session: { access_token: "memory-bearer" } },
    })
    fetchMock = vi.fn(async (path: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer memory-bearer",
      )
      requests.push({
        path,
        body: JSON.parse(String(init.body)),
        signal: init.signal,
      })
      return Response.json(
        path.endsWith("/consent")
          ? { consentToken: "grant-1" }
          : { event: { id: "cloud-1" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("does not send anything before the checkbox and separate confirmation", async () => {
    render(view())
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(requests).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "开启云端观察" }))
    expect(screen.getByText(/服务商政策/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(requests).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "确认开启" }))
    await act(async () => {})
    expect(observeRequests()).toHaveLength(1)
    expect(observeRequests()[0].body).toEqual({
      sessionId: "session-1",
      consentToken: "grant-1",
      image: "data:image/jpeg;base64,/9j/AA==",
    })
  })

  it.each([
    [false, false, "study_screen_v1"],
    [true, true, "study_screen_v1"],
    [true, false, "off_device_v1"],
  ] as const)(
    "disables cloud without an eligible running camera (%s %s %s)",
    async (active, paused, profile) => {
      render(view(active, paused, profile))
      expect(
        screen.getByRole("button", { name: "开启云端观察" }),
      ).toBeDisabled()
      await act(async () => {
        vi.advanceTimersByTime(90_000)
      })
      expect(requests).toEqual([])
      expect(capture).not.toHaveBeenCalled()
    },
  )

  it("samples at most once every 30 seconds and invalidates event queries", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries")
    render(view())
    await consent()
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["events", "user-1", "session-1"],
    })
    await act(async () => {
      vi.advanceTimersByTime(29_999)
    })
    expect(observeRequests()).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(observeRequests()).toHaveLength(2)
  })

  it("spaces uploads from completion even when observation authentication is delayed", async () => {
    vi.setSystemTime(0)
    const authenticated = {
      data: { session: { access_token: "memory-bearer" } },
    }
    const pendingAuth = deferred<typeof authenticated>()
    const pendingObservation = deferred<Response>()
    auth.getSession
      .mockResolvedValueOnce(authenticated)
      .mockReturnValueOnce(pendingAuth.promise)
    const uploadedAt: number[] = []
    const initial = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      const response = initial(path, init)
      if (!path.endsWith("/observe")) return response
      uploadedAt.push(Date.now())
      return uploadedAt.length === 1 ? pendingObservation.promise : response
    })
    render(view())
    await consent()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(uploadedAt).toEqual([])
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      pendingAuth.resolve(authenticated)
    })
    expect(uploadedAt).toEqual([5_000])
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      pendingObservation.resolve(Response.json({ event: {} }))
    })
    await act(async () => {
      vi.advanceTimersByTime(23_000)
    })
    expect(uploadedAt).toEqual([5_000])
    expect(capture).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(uploadedAt).toEqual([5_000, 60_000])
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it.each(["disabled", "pause"] as const)(
    "keeps deferred-auth cancellation and completion spacing across %s and fresh consent",
    async (reason) => {
      vi.setSystemTime(0)
      const authenticated = {
        data: { session: { access_token: "memory-bearer" } },
      }
      const pendingAuth = deferred<typeof authenticated>()
      auth.getSession
        .mockResolvedValueOnce(authenticated)
        .mockReturnValueOnce(pendingAuth.promise)
      const invalidate = vi.spyOn(client, "invalidateQueries")
      const mounted = render(view())
      await consent()
      await act(async () => {
        vi.advanceTimersByTime(35_000)
      })
      expect(capture).toHaveBeenCalledTimes(1)
      if (reason === "disabled")
        fireEvent.click(screen.getByRole("button", { name: "关闭云端观察" }))
      else mounted.rerender(view(true, true))
      await act(async () => {})
      expect(revokes()).toHaveLength(1)
      if (reason === "pause") mounted.rerender(view())
      await consent()
      expect(observeRequests()).toHaveLength(0)
      expect(capture).toHaveBeenCalledTimes(1)
      await act(async () => {
        vi.advanceTimersByTime(5_000)
        pendingAuth.resolve(authenticated)
      })
      expect(observeRequests()).toHaveLength(0)
      expect(invalidate).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(25_000)
      })
      expect(observeRequests()).toHaveLength(0)
      expect(capture).toHaveBeenCalledTimes(1)
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      expect(observeRequests()).toHaveLength(1)
      expect(capture).toHaveBeenCalledTimes(2)
      expect(invalidate).toHaveBeenCalledTimes(1)
    },
  )

  it("drops ticks while one request is in flight instead of queuing", async () => {
    const pending = deferred<Response>()
    const initial = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      const response = initial(path, init)
      return path.endsWith("/observe") ? pending.promise : response
    })
    render(view())
    await consent()
    await act(async () => {
      vi.advanceTimersByTime(90_000)
    })
    expect(observeRequests()).toHaveLength(1)
    await act(async () => {
      pending.resolve(Response.json({ event: {} }))
    })
    expect(observeRequests()).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(observeRequests()).toHaveLength(2)
  })

  it.each(["disabled", "pause", "camera", "hidden", "unmount"] as const)(
    "aborts synchronously and revokes on %s, ignoring late observations",
    async (reason) => {
      const pending = deferred<Response>()
      const initial = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation((path: string, init: RequestInit) => {
        const response = initial(path, init)
        return path.endsWith("/observe") ? pending.promise : response
      })
      const invalidate = vi.spyOn(client, "invalidateQueries")
      const mounted = render(view())
      await consent()
      const signal = observeRequests()[0].signal!
      if (reason === "disabled")
        fireEvent.click(screen.getByRole("button", { name: "关闭云端观察" }))
      if (reason === "pause") mounted.rerender(view(true, true))
      if (reason === "camera") act(() => stopRef.current())
      if (reason === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
        fireEvent(document, new Event("visibilitychange"))
      }
      if (reason === "unmount") mounted.unmount()
      expect(signal.aborted).toBe(true)
      await act(async () => {
        pending.resolve(Response.json({ event: {} }))
      })
      expect(revokes().length).toBeGreaterThan(0)
      expect(invalidate).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(90_000)
      })
      expect(observeRequests()).toHaveLength(1)
    },
  )

  it("revokes a delayed consent after cancellation and never captures it", async () => {
    const pending = deferred<Response>()
    const initial = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      const response = initial(path, init)
      return JSON.parse(String(init.body)).enabled === true
        ? pending.promise
        : response
    })
    const mounted = render(view())
    await consent()
    mounted.rerender(view(true, true))
    await act(async () => {})
    const before = revokes().length
    await act(async () => {
      pending.resolve(Response.json({ consentToken: "late-grant" }))
    })
    expect(revokes().length).toBeGreaterThan(before)
    expect(capture).not.toHaveBeenCalled()
    expect(observeRequests()).toHaveLength(0)
    mounted.rerender(view())
    expect(screen.getByRole("button", { name: "开启云端观察" })).toBeEnabled()
  })

  it("disables only cloud on provider failure and requires fresh consent", async () => {
    const initial = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      const response = initial(path, init)
      return path.endsWith("/observe")
        ? Response.json({ error: "VISION_PROVIDER_FAILED" }, { status: 502 })
        : response
    })
    render(view())
    await consent()
    expect(screen.getByText(/本地观察仍可继续/)).toBeInTheDocument()
    expect(revokes()).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(90_000)
    })
    expect(observeRequests()).toHaveLength(1)
    expect(screen.getByRole("button", { name: "开启云端观察" })).toBeEnabled()
  })

  it("blocks fresh consent until the previous revocation settles", async () => {
    const pending = deferred<Response>()
    const initial = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      const response = initial(path, init)
      return JSON.parse(String(init.body)).enabled === false
        ? pending.promise
        : response
    })
    render(view())
    await consent()
    fireEvent.click(screen.getByRole("button", { name: "关闭云端观察" }))
    expect(screen.getByRole("button", { name: "开启云端观察" })).toBeDisabled()
    await act(async () => {
      pending.resolve(Response.json({ consentToken: null }))
    })
    expect(screen.getByRole("button", { name: "开启云端观察" })).toBeEnabled()
  })
})

describe("memory-only JPEG capture", () => {
  afterEach(() => vi.restoreAllMocks())
  it.each([
    [1920, 1080, 640, 360],
    [1080, 1920, 360, 640],
    [320, 240, 320, 240],
  ])(
    "resizes %s x %s to %s x %s as JPEG",
    (width, height, targetWidth, targetHeight) => {
      const drawImage = vi.fn()
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage,
      } as unknown as CanvasRenderingContext2D)
      const encode = vi
        .spyOn(HTMLCanvasElement.prototype, "toDataURL")
        .mockReturnValue("data:image/jpeg;base64,/9j/AA==")
      const video = document.createElement("video")
      Object.defineProperties(video, {
        videoWidth: { value: width },
        videoHeight: { value: height },
        readyState: { value: 2 },
      })
      expect(captureCloudFrame(video)).toBe("data:image/jpeg;base64,/9j/AA==")
      expect(drawImage).toHaveBeenCalledWith(
        video,
        0,
        0,
        targetWidth,
        targetHeight,
      )
      expect(encode).toHaveBeenCalledWith("image/jpeg", 0.8)
    },
  )
  it("rejects unavailable and oversized frames without returning raw media", () => {
    const video = document.createElement("video")
    expect(captureCloudFrame(video)).toBeNull()
    Object.defineProperties(video, {
      videoWidth: { value: 640 },
      videoHeight: { value: 480 },
      readyState: { value: 2 },
    })
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      `data:image/jpeg;base64,${btoa("a".repeat(256 * 1024 + 1))}`,
    )
    expect(() => captureCloudFrame(video)).toThrow()
  })
})
