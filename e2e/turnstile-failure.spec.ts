import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

test.beforeEach(async ({ page }) => {
  await installMockSupabase(page, { seedSession: false })
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.abort("failed"),
  )
})

test("匿名入口在 Turnstile 脚本失败后说明原因且不绕过校验", async ({
  page,
}) => {
  await page.goto("/app")
  await page.getByLabel(/我理解匿名数据不可跨设备恢复/).click()
  await page.getByRole("button", { name: "开始体验" }).click()

  await expect(
    page.getByRole("alert").filter({ hasText: "安全校验" }),
  ).toContainText("安全校验暂不可用")
  await expect(page.getByRole("button", { name: "重新加载页面" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "等待安全校验" }),
  ).toBeDisabled()
})

test("邮箱入口在 Turnstile 脚本失败后保持提交禁用并提供重试", async ({
  page,
}) => {
  await page.goto("/auth")
  await page.getByLabel("邮箱").fill("student@example.com")

  await expect(
    page.getByRole("alert").filter({ hasText: "安全校验" }),
  ).toContainText("安全校验暂不可用")
  await expect(page.getByRole("button", { name: "重新加载页面" })).toBeVisible()
  await expect(page.getByRole("button", { name: "发送验证码" })).toBeDisabled()
})
