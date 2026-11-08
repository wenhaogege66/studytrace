import { expect, test, type Page } from "@playwright/test"
import { installMockSupabase } from "./mock-supabase"

async function persistedUser(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    )
    return key ? JSON.parse(localStorage.getItem(key) ?? "null")?.user : null
  })
}

test("密码失败不丢匿名身份", async ({ page }) => {
  const mock = await installMockSupabase(page, {
    existingAccountEmails: ["student@example.com"],
  })
  await page.goto("/auth")
  await page.getByLabel("邮箱", { exact: true }).fill("student@example.com")
  await page.getByLabel("密码", { exact: true }).fill("wrong-password")
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "登录并进入学习计划" }).click()
  await expect(
    page.getByRole("region", { name: "账号操作" }).getByRole("alert"),
  ).toContainText("邮箱或密码")
  expect((await persistedUser(page))?.id).toBe(mock.anonymousUserId)
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("")
})

test("注册为独立身份，不迁移匿名记录", async ({ page }) => {
  const mock = await installMockSupabase(page)
  await page.goto("/auth")
  await page.getByRole("button", { name: "注册", exact: true }).click()
  await expect(page.getByText(/临时记录不会迁入/)).toBeVisible()
  await page.getByLabel("邮箱", { exact: true }).fill("new@example.com")
  await page
    .getByLabel("密码", { exact: true })
    .fill("studytrace-test-password")
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "注册并进入学习计划" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect((await persistedUser(page))?.id).toBe(mock.permanentUserId)
  expect(mock.authEvents).not.toContain("request-email-upgrade")
})

test("密码登录成功后显示账号，退出会先暂停", async ({ page }) => {
  const mock = await installMockSupabase(page, {
    existingAccountEmails: ["student@example.com"],
    seedRunningStudySession: true,
  })
  await page.goto("/auth")
  await page.getByLabel("邮箱", { exact: true }).fill("student@example.com")
  await page
    .getByLabel("密码", { exact: true })
    .fill("studytrace-test-password")
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "登录并进入学习计划" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect(mock.studySessions().some((row) => row.status === "running")).toBe(
    false,
  )
  await page.goto("/auth")
  await expect(page.getByRole("heading", { name: "账号已连接" })).toBeVisible()
  await page.getByRole("button", { name: "退出账号" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect(await persistedUser(page)).toBeNull()
})

test("密码注销要求新鲜验证和明确确认", async ({ page }) => {
  const mock = await installMockSupabase(page, { accountKind: "permanent" })
  await page.goto("/auth")
  await page.getByRole("button", { name: "永久删除账号与记录" }).click()
  await page.getByLabel("再次输入密码").fill("studytrace-test-password")
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "验证密码并永久删除" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect(mock.authEvents).toContain("delete-account")
  expect(await persistedUser(page)).toBeNull()
})

test("账号界面支持键盘和紧凑手机布局", async ({ page }) => {
  await installMockSupabase(page)
  await page.goto("/auth")
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible()
  await page.screenshot({
    path: "output/playwright/auth-desktop.png",
    fullPage: true,
  })
  await page.getByLabel("邮箱", { exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(page.getByLabel("密码", { exact: true })).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible()
  const widths = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(widths.content).toBeLessThanOrEqual(widths.viewport)
  await page.screenshot({
    path: "output/playwright/auth-mobile.png",
    fullPage: true,
  })
})
