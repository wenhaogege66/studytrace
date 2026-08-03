import { expect, test } from "@playwright/test"

test("公开首页清楚说明价值与隐私边界", async ({ page }) => {
  await page.goto("/")

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "让一次学习，留下可以调整的迹。",
    }),
  ).toBeVisible()
  await expect(page.getByText("画面不离开设备", { exact: true })).toBeVisible()
  await expect(page.getByText("不做专注分数", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "进入真实体验" }),
  ).toHaveAttribute("href", "/app")
})
