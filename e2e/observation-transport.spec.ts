import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"
import { createManualPlan } from "./plan-actions"

// This is an explicitly synthetic transport/privacy contract test, not a
// recognition-accuracy test. No camera hardware, model, provider or DB is used.
test("技术模拟：云端四帧需主动授权，暂停停止上传并持久化有效覆盖", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const mock = await installMockSupabase(page)
  await page.clock.install()
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 640
    canvas.height = 480
    const context = canvas.getContext("2d")!
    context.fillStyle = "#dce8e0"
    context.fillRect(0, 0, 640, 480)
    const stream = canvas.captureStream(4)
    Object.defineProperty(window, "__syntheticObservationStream", {
      value: stream,
    })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    })
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => undefined,
    })
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get: () => 2,
    })
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => Date.now() / 1000,
    })
    Object.defineProperty(window, "createImageBitmap", {
      configurable: true,
      value: async () => ({ close() {} }),
    })
    const draw = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (
      image: CanvasImageSource,
      ...args: number[]
    ) {
      if (image instanceof HTMLVideoElement)
        Reflect.apply(draw, this, [
          canvas,
          0,
          0,
          this.canvas.width,
          this.canvas.height,
        ])
      else Reflect.apply(draw, this, [image, ...args])
    }
    class SyntheticWorker {
      private listeners = new Set<EventListenerOrEventListenerObject>()
      private closed = false
      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        if (type === "message") this.listeners.add(listener)
      }
      postMessage(message: {
        type: string
        frameId: number
        timestampMs: number
        bitmap?: ImageBitmap
      }) {
        if (message.type === "init")
          this.emit({ type: "ready", objectDetectorReady: true })
        if (message.type === "detect") {
          this.emit({
            type: "observation",
            frameId: message.frameId,
            observation: {
              timestampMs: message.timestampMs,
              facePresent: true,
              yaw: 0,
              pitch: 0,
              valid: true,
              usableForCloud: true,
              personCount: 1,
              phoneVisible: false,
            },
          })
          message.bitmap?.close()
        }
      }
      private emit(data: unknown) {
        queueMicrotask(() => {
          if (this.closed) return
          const event = new MessageEvent("message", { data })
          this.listeners.forEach((listener) =>
            typeof listener === "function"
              ? listener(event)
              : listener.handleEvent(event),
          )
        })
      }
      terminate() {
        this.closed = true
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: SyntheticWorker,
    })
  })
  const uploads: Array<{
    sessionId: string
    windowId: string
    frames: Array<{ capturedAt: string; image: string }>
  }> = []
  await page.route("**/api/observation/analyze", async (route) => {
    uploads.push(route.request().postDataJSON())
    await route.fulfill({
      json: {
        status: "complete",
        quality: "unknown",
        phone: "unknown",
        tablet: "unknown",
        candidate_event_ids: [],
        reminder_event_ids: [],
      },
    })
  })
  await page.goto("/app")
  await createManualPlan(
    page,
    "验证过程观察传输约定",
    ["验证不上传与暂停"],
    25,
    "study_paper_v1",
    "restricted",
  )
  await page.getByRole("button", { name: "开始学习", exact: true }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
  const cloud = page.getByRole("checkbox", { name: /本次同时启用云端过程观察/ })
  await expect(cloud).not.toBeChecked()
  await page.getByRole("button", { name: "开启本地观察" }).click()
  await page.clock.runFor(4_000)
  await expect(page.getByText(/基线已建立，正在本地观察/)).toBeVisible()
  await page.clock.runFor(22_000)
  expect(uploads).toHaveLength(0)
  expect(mock.observationCoverage().length).toBeGreaterThan(0)
  await cloud.click()
  await expect(cloud).toBeChecked()
  for (let index = 0; index < 10; index++) await page.clock.runFor(2_000)
  await expect.poll(() => uploads.length).toBe(1)
  expect(uploads[0].frames).toHaveLength(4)
  expect(
    Date.parse(uploads[0].frames[3].capturedAt) -
      Date.parse(uploads[0].frames[0].capturedAt),
  ).toBe(6_000)
  expect(
    uploads[0].frames.every((frame) =>
      frame.image.startsWith("data:image/jpeg;base64,"),
    ),
  ).toBe(true)
  expect(Object.keys(uploads[0]).sort()).toEqual([
    "frames",
    "sessionId",
    "windowId",
  ])
  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "继续", exact: true }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = Object.getOwnPropertyDescriptor(
          window,
          "__syntheticObservationStream",
        )?.value as MediaStream
        return value.getTracks().every((track) => track.readyState === "ended")
      }),
    )
    .toBe(true)
  await page.clock.runFor(22_000)
  expect(uploads).toHaveLength(1)
  expect(
    mock
      .observationCoverage()
      .every((batch) => Number(batch.valid_milliseconds) <= 10_000),
  ).toBe(true)
})
