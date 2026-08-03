import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

test.beforeEach(async ({ page }) => {
  await installMockSupabase(page)
})

test("任务、学习会话、摄像头拒绝与复盘构成完整降级闭环", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Camera denied in E2E", "NotAllowedError")
        },
      },
    })
  })

  await page.goto("/app")
  await expect(
    page.getByRole("heading", { name: "今天，先完成哪一件具体的事？" }),
  ).toBeVisible()

  const emptyTaskCard = page
    .getByRole("heading", { name: "任务台还是空的" })
    .locator("..")
  await emptyTaskCard.getByRole("button", { name: "新建任务" }).click()
  await page.getByLabel("任务标题").fill("完成一次科创问题定义")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("写下可验证的问题")
  await page.getByLabel("预计时长（分钟）").fill("20")
  await page.getByRole("button", { name: "创建任务" }).click()

  await expect(page.getByText("完成一次科创问题定义")).toBeVisible()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
  await expect(
    page.getByRole("heading", { name: "完成一次科创问题定义" }),
  ).toBeVisible()

  await page.getByRole("button", { name: "开启本地观察" }).click()
  await expect(
    page.getByText("你拒绝了摄像头授权。学习计时和手动复盘不会受影响。"),
  ).toBeVisible()

  await page.getByRole("button", { name: "手动标记" }).click()
  await expect(page.getByText("手动标记", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "暂停" }).click()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()
  await page.getByRole("button", { name: "继续" }).click()

  await page.getByRole("button", { name: "结束并复盘" }).click()
  await expect(page).toHaveURL(/\/app\/review\//)
  await expect(
    page.getByRole("heading", { name: "完成一次科创问题定义" }),
  ).toBeVisible()
  await expect(page.getByText("手动标记", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "修正" }).click()
  const correctionDialog = page.getByRole("dialog", { name: "修正这条事件" })
  await correctionDialog.getByRole("combobox").click()
  await page.getByRole("option", { name: "与本次复盘无关" }).click()
  await correctionDialog
    .getByLabel("修正说明（可选）")
    .fill("这是一条用于手动复盘的标记")
  await correctionDialog.getByRole("button", { name: "保存修正" }).click()
  await expect(page.getByText("已修正", { exact: true })).toBeVisible()

  await page.getByLabel("下一次只调整一件事").fill("开始前先写下验证标准")
  await page.getByRole("button", { name: "保存本次复盘" }).click()
  await expect(page.getByText("这次复盘已经保存")).toBeVisible()
})
