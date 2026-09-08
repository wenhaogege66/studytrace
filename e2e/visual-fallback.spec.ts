import { expect, test, type Page } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

async function createAndStartTask(page: Page) {
  await page.goto("/app")
  const emptyTaskCard = page
    .getByRole("heading", { name: "任务台还是空的" })
    .locator("..")
  await emptyTaskCard.getByRole("button", { name: "新建任务" }).click()
  await page.getByLabel("任务标题").fill("验证视觉能力降级")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("保持计时可用")
  await page.getByRole("button", { name: "创建任务" }).click()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
}

test("视觉模型加载失败时计时与手动复盘仍可用", async ({ page }) => {
  await installMockSupabase(page)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() },
    })
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => undefined,
    })

    class FailingWorker {
      private readonly listeners = new Set<EventListenerOrEventListenerObject>()

      addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) {
        if (type === "message") this.listeners.add(listener)
      }

      postMessage(message: unknown) {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== "init"
        )
          return

        queueMicrotask(() => {
          const event = new MessageEvent("message", {
            data: { type: "error", message: "视觉模型加载失败" },
          })
          this.listeners.forEach((listener) => {
            if (typeof listener === "function") listener(event)
            else listener.handleEvent(event)
          })
        })
      }

      terminate() {}
    }

    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: FailingWorker,
    })
  })

  await createAndStartTask(page)
  await page.getByRole("button", { name: "开启本地观察" }).click()

  await expect(
    page.getByText("视觉模型加载失败。计时与手动复盘仍可继续。"),
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeEnabled()
  await expect(page.getByRole("button", { name: "手动标记" })).toBeEnabled()
})
