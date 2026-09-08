import { expect, test } from "@playwright/test"

test("公开首页清楚说明价值与隐私边界", async ({ page }) => {
  const response = await page.goto("/")

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "让每一次行动，留下可以调整的迹。",
    }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "设计任务 · AI 先拆出第一版" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "持续执行 · 分多次推进" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "回看过程 · 每次都可复盘" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "积累规律 · 样本足够再建议" }),
  ).toBeVisible()
  await expect(page.getByText(/20 个有效投入片段和 10 个活跃日/)).toBeVisible()
  await expect(page.getByText(/至少需要 10 次用户主动标记/)).toBeVisible()
  await expect(page.getByText("画面不离开设备", { exact: true })).toBeVisible()
  await expect(page.getByText("不做专注分数", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "进入真实体验" }),
  ).toHaveAttribute("href", "/app")
  expect(response?.headers()["permissions-policy"]).toBe(
    "camera=(self), microphone=()",
  )
})
