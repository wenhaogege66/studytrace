import { expect, test, type Page } from "@playwright/test"
import { installMockSupabase } from "./mock-supabase"

async function syntheticCamera(page: Page) {
  await page.addInitScript(() => {
    class LocalWorker extends EventTarget {
      postMessage(message: { type: string; bitmap?: ImageBitmap }) {
        if (message.type === "detect") {
          message.bitmap?.close()
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", { data: { type: "frame_error" } }),
            ),
          )
        }
        if (message.type === "init")
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", { data: { type: "ready" } }),
            ),
          )
      }
      terminate() {}
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: LocalWorker,
    })
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement("canvas")
          canvas.width = 1280
          canvas.height = 720
          const context = canvas.getContext("2d")!
          context.fillStyle = "#64748b"
          context.fillRect(0, 0, canvas.width, canvas.height)
          return canvas.captureStream(1)
        },
      },
    })
  })
}

async function startTask(page: Page) {
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("云端观察测试任务")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("阅读测试材料")
  await page.getByRole("button", { name: "创建任务" }).click()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible()
}

async function enableCloud(page: Page) {
  await page.getByRole("button", { name: "开启云端观察" }).click()
  const dialog = page.getByRole("dialog", { name: "同意本次云端观察？" })
  await expect(dialog.getByRole("button", { name: "确认开启" })).toBeDisabled()
  await expect(dialog).toContainText("服务商政策")
  await dialog.getByRole("checkbox").check()
  await dialog.getByRole("button", { name: "确认开启" }).click()
}

test("cloud opt-in waits for camera save, stops on pause and preserves corrected snapshot metadata", async ({
  page,
}) => {
  const db = await installMockSupabase(page, {
    cloudVision: true,
    cameraDelayMs: 800,
  })
  await syntheticCamera(page)
  const observedSizes: number[][] = []
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/vision/observe")) return
    expect(request.headers().authorization).toMatch(/^Bearer .+/)
    expect(Object.keys(request.postDataJSON()).sort()).toEqual([
      "consentToken",
      "image",
      "sessionId",
    ])
  })
  await page.route("**/api/vision/observe", async (route) => {
    const image = route.request().postDataJSON().image as string
    observedSizes.push(
      await page.evaluate(async (dataURL) => {
        const image = new Image()
        image.src = dataURL
        await image.decode()
        return [image.width, image.height]
      }, image),
    )
    await route.fallback()
  })
  await startTask(page)
  expect(db.visionCalls).toEqual([])
  await expect(
    page.getByRole("button", { name: "开启云端观察" }),
  ).toBeDisabled()
  const cameraSave = page.waitForResponse(
    "**/rest/v1/rpc/set_study_session_camera",
  )
  await page.getByRole("button", { name: "开启本地观察" }).click()
  await expect(page.getByRole("button", { name: "关闭摄像头" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "开启云端观察" }),
  ).toBeDisabled()
  await cameraSave
  await expect(page.getByRole("button", { name: "开启云端观察" })).toBeEnabled()
  await page.getByRole("button", { name: "开启云端观察" }).click()
  await page.getByRole("dialog").getByRole("checkbox").check()
  expect(db.visionCalls).toEqual([])
  const storageBefore = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }))
  await page.getByRole("button", { name: "确认开启" }).click()
  await expect(page.getByText("测试画面不足以判断当前活动")).toBeVisible()
  expect(observedSizes).toEqual([[640, 360]])
  expect(db.behaviorEvents).toHaveLength(1)
  expect(
    await page.evaluate(() => ({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    })),
  ).toEqual(storageBefore)
  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect
    .poll(() => db.visionCalls.some((call) => call.enabled === false))
    .toBe(true)
  await expect(
    page.getByRole("button", { name: "开启云端观察" }),
  ).toBeDisabled()
  await page.getByRole("button", { name: "继续" }).click()
  await expect(page.getByRole("button", { name: "开启本地观察" })).toBeVisible()
  expect(
    db.visionCalls.filter((call) => call.endpoint === "observe"),
  ).toHaveLength(1)

  const taskStep = page.getByRole("checkbox", {
    name: "阅读测试材料",
    exact: true,
  })
  await expect(taskStep).not.toBeChecked()
  await taskStep.click()
  await expect(taskStep).toBeChecked()
  await page.getByRole("button", { name: "确认完成" }).click()
  await page.getByRole("button", { name: "完成并立即复盘" }).click()
  await expect(page).toHaveURL(/\/app\/review\//)
  await expect(page.getByText("云端观察", { exact: true })).toBeVisible()
  await expect(page.getByText(/任务关联：不确定/)).toBeVisible()
  await expect(page.getByText(/持续.*秒/)).toHaveCount(0)
  const original = structuredClone(db.behaviorEvents[0].visual_observation)
  await page.getByRole("button", { name: "修正" }).click()
  const correction = page.getByRole("dialog", { name: "修正这条事件" })
  await expect(correction.getByRole("combobox")).toContainText("保留云端观察")
  await correction.getByRole("combobox").click()
  await page.getByRole("option", { name: "与本次复盘无关" }).click()
  await correction.getByLabel("修正说明（可选）").fill("测试修正说明")
  const patch = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" &&
      request.url().includes("/behavior_events"),
  )
  await correction.getByRole("button", { name: "保存修正" }).click()
  expect(Object.keys((await patch).postDataJSON()).sort()).toEqual([
    "corrected_direction",
    "corrected_type",
    "correction_note",
    "review_status",
  ])
  await expect(page.getByText("与本次复盘无关", { exact: true })).toBeVisible()
  expect(db.behaviorEvents[0].visual_observation).toEqual(original)
  await page.reload()
  await expect(page.getByText("测试画面不足以判断当前活动")).toBeVisible()
  await page.getByRole("button", { name: "确认", exact: true }).click()
  await expect(page.getByText("已确认", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "永久删除事件" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "永久删除" })
    .click()
  await expect(page.getByText("测试画面不足以判断当前活动")).toHaveCount(0)
})

test("provider failure disables cloud without stopping the local camera", async ({
  page,
}) => {
  const db = await installMockSupabase(page, {
    cloudVision: true,
    visionFailure: true,
  })
  await syntheticCamera(page)
  await startTask(page)
  await page.getByRole("button", { name: "开启本地观察" }).click()
  await expect(page.getByRole("button", { name: "开启云端观察" })).toBeEnabled()
  await enableCloud(page)
  await expect(page.getByText(/本地观察仍可继续/)).toBeVisible()
  await expect(page.getByRole("button", { name: "关闭摄像头" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible()
  await expect
    .poll(() => db.visionCalls.some((call) => call.enabled === false))
    .toBe(true)
  expect(db.behaviorEvents).toHaveLength(0)
})

test("off-device tasks never request a camera or cloud consent", async ({
  page,
}) => {
  const db = await installMockSupabase(page, { cloudVision: true })
  let cameraRequests = 0
  await page.exposeFunction("unexpectedCameraRequest", () => {
    cameraRequests += 1
  })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          await (
            window as unknown as {
              unexpectedCameraRequest: () => Promise<void>
            }
          ).unexpectedCameraRequest()
          throw new DOMException("No real cameras in E2E", "NotAllowedError")
        },
      },
    })
  })
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("离开设备完成测试")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("走到室外")
  await page.getByLabel("任务观察方式").click()
  await page.getByRole("option", { name: "离开设备完成", exact: true }).click()
  await page.getByRole("button", { name: "创建任务" }).click()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page.getByText("此任务不使用电脑摄像头")).toBeVisible()
  await expect(page.getByRole("button", { name: "开启本地观察" })).toHaveCount(
    0,
  )
  await expect(
    page.getByRole("button", { name: "开启云端观察" }),
  ).toBeDisabled()
  expect(cameraRequests).toBe(0)
  expect(db.visionCalls).toEqual([])
})
