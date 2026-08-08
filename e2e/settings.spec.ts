import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

test("用户可以关闭轻提醒并永久清除自己的业务数据", async ({ page }) => {
  await installMockSupabase(page)
  await page.goto("/app/settings")

  await page.getByRole("tab", { name: "提醒" }).click()
  const reminderSwitch = page.getByRole("switch", { name: "允许轻提醒" })
  await expect(reminderSwitch).toBeChecked()
  await reminderSwitch.click()
  await expect(reminderSwitch).not.toBeChecked()
  await expect(page.getByText("设置已保存")).toBeVisible()

  await page.getByRole("tab", { name: "清除数据" }).click()
  await page.getByRole("button", { name: "清除我的全部数据" }).click()
  await page.getByRole("button", { name: "永久清除" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText("全部业务数据已清除")).toBeVisible()
})
