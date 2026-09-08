import { expect, test, type Page } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

const otp = "123456"
const accountFlowStorageKey = "studytrace.pending-account-flow.v1"

async function sendEmailCode(page: Page, email: string) {
  await page.getByLabel("邮箱").fill(email)
  await page.getByRole("button", { name: "发送验证码" }).click()
}

async function finishOtp(page: Page, value = otp) {
  await page.getByLabel("验证码").fill(value)
  await page.getByRole("button", { name: "完成验证" }).click()
}

test("匿名记录绑定新邮箱时保留原身份，并在顶栏明确同步状态", async ({
  page,
}) => {
  const mock = await installMockSupabase(page, {
    accountSummary: { tasks: 2, sessions: 3, reviews: 1 },
  })

  await page.goto("/app")
  const accountLink = page.getByRole("link", {
    name: "临时记录，仅此浏览器；前往保存并同步",
  })
  await expect(accountLink).toBeVisible()
  await expect(
    accountLink.getByText("临时记录 · 仅此浏览器", { exact: true }),
  ).toBeVisible()
  await expect(
    accountLink.getByText("保存并同步", { exact: true }),
  ).toBeVisible()
  await accountLink.click()

  await expect(
    page.getByRole("heading", { name: "保存并同步记录" }),
  ).toBeVisible()
  await sendEmailCode(page, "new.student@example.com")
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  expect(mock.currentUser()?.id).toBe(mock.anonymousUserId)
  expect(mock.currentUser()?.is_anonymous).toBe(true)

  await finishOtp(page)

  await expect(page.getByRole("heading", { name: "账号与同步" })).toBeVisible()
  await expect(
    page.getByText("邮箱验证完成，记录已可跨设备恢复。"),
  ).toBeVisible()
  expect(mock.currentUser()?.id).toBe(mock.anonymousUserId)
  expect(mock.currentUser()?.is_anonymous).toBe(false)

  await page.getByRole("link", { name: /继续任务/ }).click()
  const syncedAccountLink = page.getByRole("link", {
    name: /账号 .*@example\.com 已同步；前往管理或退出/,
  })
  await expect(syncedAccountLink).toBeVisible()
  await expect(syncedAccountLink.getByText("已同步 · 管理账号")).toBeVisible()
})

test("已有邮箱必须显式确认后才准备合并并发送验证码", async ({ page }) => {
  const email = "existing@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 4, sessions: 6, behaviorEvents: 2, reviews: 3 },
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)

  await expect(
    page.getByRole("heading", { name: "确认合并当前记录" }),
  ).toBeVisible()
  await expect(
    page.getByText("4 个任务 · 6 次学习时段 · 3 次复盘"),
  ).toBeVisible()
  expect(mock.authEvents).toContain("request-email-upgrade")
  expect(mock.authEvents).not.toContain("prepare-merge")
  expect(mock.authEvents).not.toContain("send-otp")

  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  await expect(
    page.getByText("验证码已发送，验证后才会开始合并。"),
  ).toBeVisible()

  await finishOtp(page)

  await expect(page.getByText("已登录并合并当前浏览器的记录。")).toBeVisible()
  await expect(page.getByText("原匿名记录已合并")).toBeVisible()
  expect(mock.currentUser()?.id).toBe(mock.permanentUserId)
  expect(mock.currentUser()?.is_anonymous).toBe(false)

  const prepareIndex = mock.authEvents.indexOf("prepare-merge")
  const sendIndex = mock.authEvents.indexOf("send-otp")
  const verifyIndex = mock.authEvents.indexOf("verify-otp")
  const consumeIndex = mock.authEvents.indexOf("consume-merge")
  expect(prepareIndex).toBeGreaterThan(-1)
  expect(prepareIndex).toBeLessThan(sendIndex)
  expect(sendIndex).toBeLessThan(verifyIndex)
  expect(verifyIndex).toBeLessThan(consumeIndex)
})

test("邮箱账号退出当前设备后可以再次用验证码恢复", async ({ page }) => {
  const email = "returning@example.com"
  const mock = await installMockSupabase(page, {
    accountKind: "permanent",
    accountEmail: email,
  })

  await page.goto("/auth")
  await expect(page.getByRole("heading", { name: "账号与同步" })).toBeVisible()
  await page.getByRole("button", { name: "退出当前设备" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole("button", { name: "开始体验" })).toBeVisible()
  expect(mock.currentUser()).toBeNull()

  await page.goto("/auth")
  await expect(
    page.getByRole("heading", { name: "恢复已有记录" }),
  ).toBeVisible()
  await sendEmailCode(page, email)
  await finishOtp(page)

  await expect(page.getByRole("heading", { name: "账号与同步" })).toBeVisible()
  await expect(
    page.getByText("邮箱验证完成，记录已可跨设备恢复。"),
  ).toBeVisible()
  expect(mock.currentUser()?.id).toBe(mock.permanentUserId)
  expect(mock.authEvents.indexOf("logout")).toBeLessThan(
    mock.authEvents.lastIndexOf("send-otp"),
  )
})

test("退出邮箱账号前先暂停正在运行的学习时段", async ({ page }) => {
  const mock = await installMockSupabase(page, {
    accountKind: "permanent",
    accountEmail: "active@example.com",
    seedRunningStudySession: true,
  })

  await page.goto("/auth")
  await page.getByRole("button", { name: "退出当前设备" }).click()
  await expect(page).toHaveURL(/\/app$/)

  const pauseIndex = mock.authEvents.indexOf("pause-active-session")
  const logoutIndex = mock.authEvents.indexOf("logout")
  expect(pauseIndex).toBeGreaterThan(-1)
  expect(pauseIndex).toBeLessThan(logoutIndex)
  expect(mock.studySessions()[0]?.status).toBe("paused")
})

test("验证码长度与服务端错误都保持在可恢复的验证状态", async ({ page }) => {
  await installMockSupabase(page)
  await page.goto("/auth")
  await sendEmailCode(page, "otp-state@example.com")

  const otpInput = page.getByLabel("验证码")
  const submit = page.getByRole("button", { name: "完成验证" })
  await otpInput.fill("12a34b5")
  await expect(otpInput).toHaveValue("12345")
  await expect(submit).toBeDisabled()

  await otpInput.fill("654321")
  await submit.click()
  await expect(
    page.getByRole("alert").filter({
      hasText: "验证码错误或已过期，请重新获取",
    }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()

  await page.reload()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  await expect(page.getByLabel("验证码")).toHaveValue("")
})

test("过期的验证流程会被清除并给出重新发起提示", async ({ page }) => {
  await installMockSupabase(page)
  await page.addInitScript(
    ({ key, value }) => window.sessionStorage.setItem(key, value),
    {
      key: accountFlowStorageKey,
      value: JSON.stringify({
        kind: "upgrade",
        email: "expired@example.com",
        sentAt: Date.now() - 11 * 60_000,
        sourceUserId: "e2e00000-0000-4000-8000-000000000001",
      }),
    },
  )

  await page.goto("/auth")

  await expect(
    page.getByRole("heading", { name: "保存并同步记录" }),
  ).toBeVisible()
  await expect(
    page.getByRole("status").filter({
      hasText: "上次验证已过期，请重新发起。",
    }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      accountFlowStorageKey,
    ),
  ).toBeNull()
})
