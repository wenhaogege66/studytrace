import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

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
  await expect(page.getByText(/跨天任务|阶段总结/)).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "进入真实体验" }),
  ).toHaveAttribute("href", "/app")
})

test("跨天计划路由已撤除，任务导航仍可使用", async ({
  page,
  request,
}, testInfo) => {
  const planPath = "/app/plans/33333333-3333-4333-8333-333333333333"
  for (const path of [
    "/app/plans",
    "/app/plans/new",
    planPath,
    `${planPath}/summary`,
  ]) {
    expect.soft((await request.get(path)).status(), path).toBe(404)
  }
  for (const action of ["clarify", "generate", "adjust"]) {
    expect
      .soft(
        (await request.post(`/api/plans/${action}`, { data: {} })).status(),
        action,
      )
      .toBe(404)
  }
  await installMockSupabase(page)
  await page.goto("/app")
  await expect(
    page.getByRole("heading", { name: "今天，先完成哪一件具体的事？" }),
  ).toBeVisible()
  const navigation = page.getByRole("navigation", {
    name:
      testInfo.project.name === "mobile-chromium" ? "移动端导航" : "应用导航",
  })
  await expect(navigation).toBeVisible()
  await expect(
    navigation.getByRole("link", { name: "计划", exact: true }),
  ).toHaveCount(0)
  await expect(
    navigation.getByRole("link", { name: "任务", exact: true }),
  ).toBeVisible()
})
