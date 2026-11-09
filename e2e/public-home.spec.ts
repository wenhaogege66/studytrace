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
    page.getByRole("heading", { name: "学习计划 · 先明确目的与标准" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "本次学习 · 分多次推进" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "学习复盘 · 校正过程线索" }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "学习报告 · 结论有真实依据" }),
  ).toBeVisible()
  await expect(
    page.getByText(/20 个有效(?:投入)?片段和 10 个活跃日/).first(),
  ).toBeVisible()
  await expect(page.getByText(/至少需要 10 次用户主动标记/)).toBeVisible()
  await expect(
    page.getByText("本地优先，云端需另行同意", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText("不做专注分数", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "进入真实体验" }),
  ).toHaveAttribute("href", "/app")
  expect(response?.headers()["permissions-policy"]).toBe(
    "camera=(self), microphone=()",
  )
})
