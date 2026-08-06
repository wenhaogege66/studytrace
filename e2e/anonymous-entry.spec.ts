import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

test("首次体验明确匿名数据边界并创建匿名会话", async ({ page }) => {
  await installMockSupabase(page, {
    seedSession: false,
    seedSettings: false,
  })
  await page.goto("/app")

  await expect(
    page.getByRole("heading", {
      name: "先把要做的事说清楚，再开始一段可复盘的学习。",
    }),
  ).toBeVisible()
  await expect(page.getByText("清除浏览器数据后不可恢复")).toBeVisible()
  await page
    .getByLabel("我理解匿名数据不可跨设备恢复，并同意仅保存结构化学习记录。")
    .check()
  await page.getByRole("button", { name: "开始体验" }).click()

  await expect(
    page.getByRole("heading", { name: "今天，先完成哪一件具体的事？" }),
  ).toBeVisible()
})

test("示例数据必须由用户主动载入", async ({ page }) => {
  await installMockSupabase(page)
  await page.goto("/app")

  const emptyTaskCard = page
    .getByRole("heading", { name: "任务台还是空的" })
    .locator("..")
  await emptyTaskCard.getByRole("button", { name: "载入示例" }).click()

  await expect(page.getByText("完成光合作用实验复盘")).toBeVisible()
  await expect(page.getByText("练习三道函数综合题")).toBeVisible()
})
