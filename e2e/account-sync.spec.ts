import { expect, test, type Page } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

const otp = "123456"
const accountFlowStorageKey = "studytrace.pending-account-flow.v1"
const mergeRecoveryStorageKey = "studytrace.pending-account-merge-recovery.v1"
const mergeHandoffStorageKey = "studytrace.account-merge-handoff.v1"
const durableMergeStorageKey = "studytrace.pending-account-merge-durable.v2"

async function persistedUser(page: Page) {
  return page.evaluate(() => {
    const storageKey = Object.keys(localStorage).find(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    )
    if (!storageKey) return null
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    return (JSON.parse(raw) as { user?: Record<string, unknown> }).user ?? null
  })
}

async function sendEmailCode(page: Page, email: string) {
  await page.getByLabel("邮箱").fill(email)
  await page.getByRole("button", { name: "发送验证码" }).click()
}

async function finishOtp(page: Page, value = otp) {
  const input = page.getByLabel("验证码")
  const submit = page.getByRole("button", { name: "完成验证" })
  const changeEmail = page.getByRole("button", { name: "更换邮箱" })
  if (await changeEmail.isVisible()) await expect(changeEmail).toBeEnabled()
  await input.fill(value)
  await expect(input).toHaveValue(value)
  await expect(submit).toBeEnabled()
  await submit.click()
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

  await page.getByRole("button", { name: "删除账号与全部记录" }).click()
  const keepAccount = page.getByRole("button", { name: "保留账号" })
  const continueDeletion = page.getByRole("button", { name: "继续验证" })
  expect((await keepAccount.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  expect((await continueDeletion.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  )
  await keepAccount.click()

  await page.getByRole("link", { name: /继续任务/ }).click()
  const syncedAccountLink = page.getByRole("link", {
    name: /账号 .*@example\.com 已同步；前往管理或退出/,
  })
  await expect(syncedAccountLink).toBeVisible()
  await expect(syncedAccountLink.getByText("已同步 · 管理账号")).toBeVisible()
})

test("320px 手机首屏先显示账号操作且导航与触控状态可访问", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await installMockSupabase(page)

  await page.goto("/auth")
  const emailInput = page.getByLabel("邮箱")
  await expect(emailInput).toBeVisible()
  const emailBox = await emailInput.boundingBox()
  expect(emailBox?.y).toBeLessThan(480)

  await page.goto("/app")
  const brand = page.getByRole("link", { name: "学迹任务首页" })
  const brandBox = await brand.boundingBox()
  expect(brandBox?.y).toBeGreaterThanOrEqual(0)
  expect((brandBox?.y ?? 0) + (brandBox?.height ?? 0)).toBeLessThanOrEqual(72)

  const mobileNav = page.getByRole("navigation", { name: "移动端导航" })
  await expect(mobileNav.getByRole("link", { name: "任务" })).toHaveAttribute(
    "aria-current",
    "page",
  )
})

test("账号步骤切换移动焦点且次要操作保持 44px 触控高度", async ({ page }) => {
  const email = "focus@example.com"
  await installMockSupabase(page, { existingAccountEmails: [email] })
  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()

  const otpInput = page.getByLabel("验证码")
  await expect(otpInput).toBeFocused()
  const changeEmail = page.getByRole("button", { name: "更换邮箱" })
  const changeBox = await changeEmail.boundingBox()
  expect(changeBox?.height).toBeGreaterThanOrEqual(44)

  await changeEmail.click()
  await expect(page.getByLabel("邮箱")).toBeFocused()
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

test("取消已准备的合并后可以立即重新发起", async ({ page }) => {
  const email = "cancel-retry@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()

  await page.getByRole("button", { name: "更换邮箱" }).click()
  await expect(
    page.getByText("已取消本次验证，可以立即重新发起。"),
  ).toBeVisible()
  expect(mock.authEvents).toContain("cancel-merge")

  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  expect(
    mock.authEvents.filter((event) => event === "prepare-merge"),
  ).toHaveLength(2)
})

test("恢复槽缺失但主会话仍是匿名源时回到可继续或取消的验证态", async ({
  page,
}) => {
  const mock = await installMockSupabase(page, {
    existingAccountEmails: ["before-switch@example.com"],
  })
  await page.addInitScript(
    ({ flowKey, sourceUserId }) => {
      sessionStorage.setItem(
        flowKey,
        JSON.stringify({
          kind: "merge",
          email: "before-switch@example.com",
          sentAt: Date.now(),
          sourceUserId,
          mergeSecret: "a".repeat(64),
          mergeRecoveryRequired: true,
        }),
      )
    },
    {
      flowKey: accountFlowStorageKey,
      sourceUserId: mock.anonymousUserId,
    },
  )

  await page.goto("/auth")

  await expect(
    page.getByText("目标会话未保留，请重新输入邮箱验证码继续确认。"),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "更换邮箱" })).toBeVisible()
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      "studytrace.pending-account-merge-recovery.v1",
    ),
  ).toBeNull()

  await page.getByRole("button", { name: "更换邮箱" }).click()
  await expect(
    page.getByText("已取消本次验证，可以立即重新发起。"),
  ).toBeVisible()
})

test("合并已提交但响应丢失时，同一账号会话可从短时回执恢复", async ({
  page,
}) => {
  const email = "lost-response@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 2, sessions: 1, reviews: 1 },
    loseFirstMergeResponse: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)

  await expect(page.getByText("网络连接失败，请检查网络后重试")).toBeVisible()
  expect(mock.authEvents).toContain("consume-merge")

  await page.reload()

  await expect(page.getByRole("heading", { name: "账号与同步" })).toBeVisible()
  await expect(page.getByText("邮箱账号已恢复，记录同步完成。")).toBeVisible()
  await expect(page.getByText("原匿名记录已合并")).toBeVisible()
  expect(mock.authEvents).toContain("recover-merge-receipt")
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
})

test("合并响应丢失后关闭标签页，重新验证同一目标邮箱仍可找回记录", async ({
  page,
  context,
}) => {
  const email = "tab-close-recovery@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 3, sessions: 2, reviews: 1 },
    loseFirstMergeResponse: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)
  await expect(page.getByText("网络连接失败，请检查网络后重试")).toBeVisible()

  const durableState = await page.evaluate(
    ({ flowKey, recoveryKey, markerKey, durableKey }) => ({
      flow: localStorage.getItem(flowKey),
      recovery: localStorage.getItem(recoveryKey),
      marker: localStorage.getItem(markerKey),
      durable: localStorage.getItem(durableKey),
    }),
    {
      flowKey: accountFlowStorageKey,
      recoveryKey: mergeRecoveryStorageKey,
      markerKey: mergeHandoffStorageKey,
      durableKey: durableMergeStorageKey,
    },
  )
  expect(durableState.flow).toBeNull()
  expect(durableState.recovery).toBeNull()
  expect(durableState.marker).toContain(mock.permanentUserId)
  expect(durableState.marker).not.toContain("refresh")
  expect(durableState.marker).not.toContain("a".repeat(64))
  expect(durableState.durable).toContain('"mergeSecret"')
  expect(durableState.durable).not.toContain("accessToken")
  expect(durableState.durable).not.toContain("refreshToken")

  await page.close()
  const restoredPage = await context.newPage()
  await restoredPage.goto("/auth")

  await expect(
    restoredPage.getByText(
      "上次匿名身份已失效。请用刚验证的邮箱重新登录并核对合并记录。",
    ),
  ).toBeVisible()
  await expect(restoredPage.getByLabel("邮箱")).toHaveValue(email)
  await sendEmailCode(restoredPage, email)
  await finishOtp(restoredPage)

  await expect(
    restoredPage.getByText("邮箱验证完成，记录已可跨设备恢复。"),
  ).toBeVisible()
  expect(
    await restoredPage.evaluate(
      (key) => localStorage.getItem(key),
      mergeHandoffStorageKey,
    ),
  ).toBeNull()
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
})

test("合并尚未提交且主会话被其他标签清除后，关闭原标签仍可凭短时能力继续", async ({
  page,
  context,
}) => {
  const email = "uncommitted-tab-close@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 3, sessions: 2, reviews: 1 },
    timeoutBeforeMergeThenCapacityRollback: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)
  await expect(page.getByText(/服务响应暂时中断/)).toBeVisible()

  const durable = await page.evaluate(
    (key) => localStorage.getItem(key),
    durableMergeStorageKey,
  )
  expect(durable).toContain('"mergeSecret"')
  expect(durable).toContain(mock.permanentUserId)
  expect(durable).not.toContain("accessToken")
  expect(durable).not.toContain("refreshToken")

  // Simulates another tab replacing/clearing the shared persistent session
  // before this tab is closed. The anonymous auth user and DB rows still
  // exist because the first consume request did not commit.
  await mock.clearPersistentSession(page)
  await page.close()

  const restoredPage = await context.newPage()
  await restoredPage.goto("/auth")
  await expect(
    restoredPage.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  await expect(restoredPage.getByText(/请重新发送验证码至/)).toBeVisible()
  await restoredPage.getByRole("button", { name: "重新获取" }).click()
  await finishOtp(restoredPage)

  // The merge commits while the persistent main session is deliberately
  // null, so the UI requires one fresh persistent target verification before
  // declaring recovery complete.
  await expect(
    restoredPage.getByText("请重新发送验证码，验证目标邮箱并核对合并记录。"),
  ).toBeVisible()
  await restoredPage.getByRole("button", { name: "重新获取" }).click()
  await finishOtp(restoredPage)
  await expect(
    restoredPage.getByText("邮箱验证完成，记录已可跨设备恢复。"),
  ).toBeVisible()
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
  expect(
    await restoredPage.evaluate(
      (key) => localStorage.getItem(key),
      durableMergeStorageKey,
    ),
  ).toBeNull()
})

test("prepare 已提交但响应丢失后，关闭标签仍可复用同一短时能力", async ({
  page,
  context,
}) => {
  const email = "prepare-response-lost@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    loseFirstPrepareResponse: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(page.getByText(/网络连接失败/)).toBeVisible()
  const durableBeforeClose = await page.evaluate(
    (key) => localStorage.getItem(key),
    durableMergeStorageKey,
  )
  expect(durableBeforeClose).toContain('"mergeSecret"')

  await page.close()
  const restoredPage = await context.newPage()
  await restoredPage.goto("/auth")
  await restoredPage.getByRole("button", { name: "重新获取" }).click()
  await finishOtp(restoredPage)

  await expect(
    restoredPage.getByText("已登录并合并当前浏览器的记录。"),
  ).toBeVisible()
  expect(
    mock.authEvents.filter((event) => event === "prepare-merge"),
  ).toHaveLength(2)
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
})

test("两个标签同时确认同一合并时复用一个 capability，不互相覆盖", async ({
  page,
  context,
}) => {
  const email = "two-tab-prepare@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
  })
  const secondPage = await context.newPage()

  await Promise.all([page.goto("/auth"), secondPage.goto("/auth")])
  await Promise.all([
    sendEmailCode(page, email),
    sendEmailCode(secondPage, email),
  ])
  await Promise.all([
    page.getByRole("button", { name: "确认并发送验证码" }).click(),
    secondPage.getByRole("button", { name: "确认并发送验证码" }).click(),
  ])

  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  await expect(
    secondPage.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  const [firstFlow, secondFlow, durable] = await Promise.all([
    page.evaluate((key) => sessionStorage.getItem(key), accountFlowStorageKey),
    secondPage.evaluate(
      (key) => sessionStorage.getItem(key),
      accountFlowStorageKey,
    ),
    page.evaluate((key) => localStorage.getItem(key), durableMergeStorageKey),
  ])
  expect(JSON.parse(firstFlow ?? "{}").mergeSecret).toBe(
    JSON.parse(secondFlow ?? "{}").mergeSecret,
  )
  expect(JSON.parse(durable ?? "{}").mergeSecret).toBe(
    JSON.parse(firstFlow ?? "{}").mergeSecret,
  )
  expect(
    mock.authEvents.filter((event) => event === "prepare-merge"),
  ).toHaveLength(2)
})

test("首个 prepare 明确回滚时，等待中的标签会创建新 capability 且不被旧清理擦除", async ({
  page,
  context,
}) => {
  const email = "prepare-waiter@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    rejectFirstPrepareDefinitively: true,
  })
  const secondPage = await context.newPage()

  await Promise.all([page.goto("/auth"), secondPage.goto("/auth")])
  await Promise.all([
    sendEmailCode(page, email),
    sendEmailCode(secondPage, email),
  ])
  await Promise.all([
    page.getByRole("button", { name: "确认并发送验证码" }).click(),
    secondPage.getByRole("button", { name: "确认并发送验证码" }).click(),
  ])

  await expect
    .poll(
      () =>
        mock.authEvents.filter((event) => event === "prepare-merge-rollback")
          .length,
    )
    .toBe(1)
  await expect
    .poll(
      () => mock.authEvents.filter((event) => event === "prepare-merge").length,
    )
    .toBe(1)
  const durable = JSON.parse(
    (await page.evaluate(
      (key) => localStorage.getItem(key),
      durableMergeStorageKey,
    )) ?? "{}",
  )
  expect(durable.mergeSecret).toMatch(/^[a-f0-9]{64}$/)

  const storedFlows = await Promise.all(
    [page, secondPage].map((candidate) =>
      candidate.evaluate(
        (key) => sessionStorage.getItem(key),
        accountFlowStorageKey,
      ),
    ),
  )
  expect(
    storedFlows.some(
      (value) => JSON.parse(value ?? "{}").mergeSecret === durable.mergeSecret,
    ),
  ).toBe(true)
})

test("取消与旧标签重发串行化，已撤销 capability 不会被重新激活", async ({
  page,
  context,
}) => {
  const email = "cancel-versus-resend@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    cancelMergeDelayMs: 700,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  const stalePage = await context.newPage()
  await stalePage.goto("/auth")

  await page.getByRole("button", { name: "更换邮箱" }).click()
  await expect.poll(() => mock.authEvents).toContain("cancel-merge-start")
  await stalePage.getByRole("button", { name: "重新获取" }).click()

  await expect(
    page.getByText("已取消本次验证，可以立即重新发起。"),
  ).toBeVisible()
  await expect(
    stalePage.getByText(/流程已在其他标签页取消或改变/),
  ).toBeVisible()
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      durableMergeStorageKey,
    ),
  ).toBeNull()
  expect(
    mock.authEvents.filter((event) => event === "prepare-merge"),
  ).toHaveLength(1)
})

test("旧标签的 OTP 回调不能覆盖已取消后新建的 capability", async ({
  page,
  context,
}) => {
  const email = "stale-otp-callback@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    verifyOtpDelayMs: 5_000,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(page.getByRole("button", { name: "更换邮箱" })).toBeEnabled()
  const oldSecret = JSON.parse(
    (await page.evaluate(
      (key) => sessionStorage.getItem(key),
      accountFlowStorageKey,
    )) ?? "{}",
  ).mergeSecret
  await page.getByLabel("验证码").fill(otp)
  await page.getByRole("button", { name: "完成验证" }).click()
  await expect
    .poll(
      () => mock.authEvents.filter((event) => event === "verify-otp").length,
    )
    .toBe(1)

  const replacementPage = await context.newPage()
  await replacementPage.goto("/auth")
  await replacementPage.getByRole("button", { name: "更换邮箱" }).click()
  await expect(
    replacementPage.getByText("已取消本次验证，可以立即重新发起。"),
  ).toBeVisible()
  await sendEmailCode(replacementPage, email)
  await replacementPage
    .getByRole("button", { name: "确认并发送验证码" })
    .click()
  await expect(
    replacementPage.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()

  await expect(page.getByText(/记录合并流程已在其他标签页改变/)).toBeVisible()
  const durable = JSON.parse(
    (await replacementPage.evaluate(
      (key) => localStorage.getItem(key),
      durableMergeStorageKey,
    )) ?? "{}",
  )
  expect(durable.mergeSecret).not.toBe(oldSecret)
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(0)
})

test("另一标签已消费 capability 时，旧 prepare 的确定失败不会擦除恢复凭证", async ({
  page,
  context,
}) => {
  const email = "consume-versus-stale-prepare@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    loseFirstMergeResponse: true,
  })
  const consumerPage = await context.newPage()

  await Promise.all([page.goto("/auth"), consumerPage.goto("/auth")])
  await Promise.all([
    sendEmailCode(page, email),
    sendEmailCode(consumerPage, email),
  ])
  await consumerPage.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(
    consumerPage.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  const sharedSecret = JSON.parse(
    (await consumerPage.evaluate(
      (key) => localStorage.getItem(key),
      durableMergeStorageKey,
    )) ?? "{}",
  ).mergeSecret
  await finishOtp(consumerPage)
  await expect(
    consumerPage.getByText("网络连接失败，请检查网络后重试"),
  ).toBeVisible()

  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(page.getByText(/当前匿名记录已发生变化/)).toBeVisible()
  expect(mock.authEvents).toContain("prepare-merge-source-invalid")
  expect(mock.authEvents).toContain("cancel-merge-miss")
  const durable = JSON.parse(
    (await page.evaluate(
      (key) => localStorage.getItem(key),
      durableMergeStorageKey,
    )) ?? "{}",
  )
  expect(durable.mergeSecret).toBe(sharedSecret)

  await consumerPage.reload()
  await expect(
    consumerPage.getByText("邮箱账号已恢复，记录同步完成。"),
  ).toBeVisible()
  expect(mock.authEvents).toContain("recover-merge-receipt")
})

test("合并成功后的摘要刷新失败不会重新打开已消费的合并流程", async ({
  page,
}) => {
  const email = "summary-after-merge@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    failSummaryAfterMerge: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)

  await expect(page.getByRole("heading", { name: "账号与同步" })).toBeVisible()
  await expect(page.getByText(/同步摘要刷新失败/)).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toHaveCount(0)
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
  expect(
    await page.evaluate(
      ({ flowKey, durableKey }) => ({
        flow: sessionStorage.getItem(flowKey),
        durable: localStorage.getItem(durableKey),
      }),
      {
        flowKey: accountFlowStorageKey,
        durableKey: durableMergeStorageKey,
      },
    ),
  ).toEqual({ flow: null, durable: null })
})

test("回执已提交但主会话被另一标签清除时，重新 OTP 登录且不重复合并", async ({
  page,
  context,
}) => {
  const email = "guard-null-recovery@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 2, sessions: 1 },
    mergeResponseDelayMs: 8_000,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  const changeEmail = page.getByRole("button", { name: "更换邮箱" })
  await expect(changeEmail).toBeEnabled()
  await page.getByLabel("验证码").fill(otp)
  await page.getByRole("button", { name: "完成验证" }).click()
  await expect
    .poll(
      () => mock.authEvents.filter((event) => event === "consume-merge").length,
    )
    .toBe(1)

  const otherPage = await context.newPage()
  await otherPage.goto("/auth")
  await expect(otherPage.getByText(/上次匿名身份已失效/)).toBeVisible()
  await otherPage.close()

  await expect(
    page.getByText("请重新发送验证码，验证目标邮箱并核对合并记录。"),
  ).toBeVisible()
  await expect(page.getByLabel("验证码")).toHaveValue("")
  await page.getByRole("button", { name: "重新获取" }).click()
  await expect(page.getByText("新的验证码已发送。")).toBeVisible()
  await finishOtp(page)

  await expect(
    page.getByText("邮箱验证完成，记录已可跨设备恢复。"),
  ).toBeVisible()
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
  expect(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      mergeHandoffStorageKey,
    ),
  ).toBeNull()
})

test("主会话已提交但清理本地状态前崩溃时，用原会话回执完成恢复", async ({
  page,
}) => {
  const email = "post-commit-crash@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 2, sessions: 2, reviews: 1 },
  })
  await page.addInitScript(
    ({ flowKey, recoveryKey, markerKey, allowCleanupKey }) => {
      const originalRemoveItem = Storage.prototype.removeItem
      Storage.prototype.removeItem = function (key: string) {
        const authKey = Object.keys(localStorage).find(
          (candidate) =>
            candidate.startsWith("sb-") && candidate.endsWith("-auth-token"),
        )
        const authValue = authKey ? localStorage.getItem(authKey) : null
        const permanent = authValue
          ? (JSON.parse(authValue) as { user?: { is_anonymous?: boolean } })
              .user?.is_anonymous === false
          : false
        if (
          localStorage.getItem(allowCleanupKey) !== "true" &&
          permanent &&
          [flowKey, recoveryKey, markerKey].includes(key)
        ) {
          return
        }
        return originalRemoveItem.call(this, key)
      }
    },
    {
      flowKey: accountFlowStorageKey,
      recoveryKey: mergeRecoveryStorageKey,
      markerKey: mergeHandoffStorageKey,
      allowCleanupKey: "studytrace.e2e.allow-recovery-cleanup",
    },
  )

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)
  await expect(page.getByText("已登录并合并当前浏览器的记录。")).toBeVisible()
  expect(
    await page.evaluate(
      ({ flowKey, recoveryKey, markerKey }) => ({
        flow: sessionStorage.getItem(flowKey),
        recovery: sessionStorage.getItem(recoveryKey),
        marker: localStorage.getItem(markerKey),
      }),
      {
        flowKey: accountFlowStorageKey,
        recoveryKey: mergeRecoveryStorageKey,
        markerKey: mergeHandoffStorageKey,
      },
    ),
  ).toMatchObject({
    flow: expect.any(String),
    recovery: expect.any(String),
    marker: expect.any(String),
  })

  await page.evaluate(() =>
    localStorage.setItem("studytrace.e2e.allow-recovery-cleanup", "true"),
  )
  await page.reload()

  await expect(page.getByText("邮箱账号已恢复，记录同步完成。")).toBeVisible()
  expect(mock.authEvents).toContain("recover-merge-receipt")
  expect(
    await page.evaluate(
      ({ flowKey, recoveryKey, markerKey }) => ({
        flow: sessionStorage.getItem(flowKey),
        recovery: sessionStorage.getItem(recoveryKey),
        marker: localStorage.getItem(markerKey),
      }),
      {
        flowKey: accountFlowStorageKey,
        recoveryKey: mergeRecoveryStorageKey,
        markerKey: mergeHandoffStorageKey,
      },
    ),
  ).toEqual({ flow: null, recovery: null, marker: null })
})

test("主会话已切到目标且 sessionStorage 已清空时，从 durable capability 读取原会话回执", async ({
  page,
}) => {
  const email = "durable-only-post-commit@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    accountSummary: { tasks: 2, sessions: 1, reviews: 1 },
  })
  await page.addInitScript(
    ({ durableKey, markerKey, allowCleanupKey }) => {
      const originalRemoveItem = Storage.prototype.removeItem
      Storage.prototype.removeItem = function (key: string) {
        const authKey = Object.keys(localStorage).find(
          (candidate) =>
            candidate.startsWith("sb-") && candidate.endsWith("-auth-token"),
        )
        const authValue = authKey ? localStorage.getItem(authKey) : null
        const permanent = authValue
          ? (JSON.parse(authValue) as { user?: { is_anonymous?: boolean } })
              .user?.is_anonymous === false
          : false
        if (
          localStorage.getItem(allowCleanupKey) !== "true" &&
          permanent &&
          this === localStorage &&
          [durableKey, markerKey].includes(key)
        ) {
          return
        }
        return originalRemoveItem.call(this, key)
      }
    },
    {
      durableKey: durableMergeStorageKey,
      markerKey: mergeHandoffStorageKey,
      allowCleanupKey: "studytrace.e2e.allow-durable-cleanup",
    },
  )

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)
  await expect(page.getByText("已登录并合并当前浏览器的记录。")).toBeVisible()

  expect(
    await page.evaluate(
      ({ flowKey, recoveryKey, durableKey, markerKey }) => ({
        flow: sessionStorage.getItem(flowKey),
        recovery: sessionStorage.getItem(recoveryKey),
        durable: localStorage.getItem(durableKey),
        marker: localStorage.getItem(markerKey),
      }),
      {
        flowKey: accountFlowStorageKey,
        recoveryKey: mergeRecoveryStorageKey,
        durableKey: durableMergeStorageKey,
        markerKey: mergeHandoffStorageKey,
      },
    ),
  ).toMatchObject({
    flow: null,
    recovery: null,
    durable: expect.any(String),
    marker: expect.any(String),
  })

  await page.evaluate(() =>
    localStorage.setItem("studytrace.e2e.allow-durable-cleanup", "true"),
  )
  await page.reload()

  await expect(page.getByText("邮箱账号已恢复，记录同步完成。")).toBeVisible()
  expect(mock.authEvents).toContain("recover-merge-receipt")
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
  await expect
    .poll(() =>
      page.evaluate(
        ({ durableKey, markerKey }) => ({
          durable: localStorage.getItem(durableKey),
          marker: localStorage.getItem(markerKey),
        }),
        {
          durableKey: durableMergeStorageKey,
          markerKey: mergeHandoffStorageKey,
        },
      ),
    )
    .toEqual({ durable: null, marker: null })
})

test("重复提交同一验证码只执行一次目标验证与合并", async ({ page }) => {
  const email = "single-flight@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await expect(page.getByRole("button", { name: "更换邮箱" })).toBeEnabled()
  await page.getByLabel("验证码").fill(otp)
  await page.locator("form").evaluate((form) => {
    ;(form as HTMLFormElement).requestSubmit()
    ;(form as HTMLFormElement).requestSubmit()
  })

  await expect(page.getByText("已登录并合并当前浏览器的记录。")).toBeVisible()
  expect(
    mock.authEvents.filter((event) => event === "verify-otp"),
  ).toHaveLength(1)
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
})

test("过期的短时目标令牌轮换后先持久化新令牌，再完成一次合并", async ({
  page,
}) => {
  const email = "rotated-recovery@example.com"
  const mock = await installMockSupabase(page, {
    seedExpiredMergeRecovery: {
      email,
      mergeSecret: "d".repeat(64),
    },
    accountSummary: { tasks: 1, sessions: 1 },
  })

  await page.goto("/auth")

  await expect(page.getByText("邮箱账号已恢复，记录同步完成。")).toBeVisible()
  expect(mock.authEvents).toContain("refresh-target-session")
  expect(mock.authEvents.indexOf("refresh-target-session")).toBeLessThan(
    mock.authEvents.indexOf("consume-merge"),
  )
  expect(
    mock.authEvents.filter((event) => event === "consume-merge"),
  ).toHaveLength(1)
  const persistentSession = await page.evaluate(() => {
    const storageKey = Object.keys(localStorage).find(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    )
    return storageKey ? localStorage.getItem(storageKey) : null
  })
  expect(persistentSession).toContain("-rotated")
})

for (const uncertainResult of [
  {
    name: "HTTP 504",
    mockOptions: { gatewayTimeoutAfterMerge: true },
    errorText: "服务响应暂时中断，请保留当前页面并重试",
  },
  {
    name: "响应结构异常",
    mockOptions: { invalidFirstMergeShape: true },
    errorText: "合并结果格式异常，请保留当前页面并重试确认",
  },
] as const) {
  test(`${uncertainResult.name} 不覆盖目标会话，并可用同一回执恢复`, async ({
    page,
  }) => {
    const email = `${uncertainResult.name === "HTTP 504" ? "gateway" : "shape"}@example.com`
    const mock = await installMockSupabase(page, {
      existingAccountEmails: [email],
      accountSummary: { tasks: 1, sessions: 2 },
      ...uncertainResult.mockOptions,
    })

    await page.goto("/auth")
    await sendEmailCode(page, email)
    await page.getByRole("button", { name: "确认并发送验证码" }).click()
    await finishOtp(page)

    await expect(page.getByText(uncertainResult.errorText)).toBeVisible()
    expect((await persistedUser(page))?.id).toBe(mock.anonymousUserId)
    expect((await persistedUser(page))?.is_anonymous).toBe(true)

    await page.reload()

    await expect(page.getByText("邮箱账号已恢复，记录同步完成。")).toBeVisible()
    await expect(page.getByText("原匿名记录已合并")).toBeVisible()
    expect(mock.authEvents).toContain("recover-merge-receipt")
    expect(
      mock.authEvents.filter((event) => event === "consume-merge"),
    ).toHaveLength(1)
  })
}

test("未提交的超时在刷新后得到明确回滚，并恢复原匿名会话", async ({ page }) => {
  const email = "timeout-rollback@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    timeoutBeforeMergeThenCapacityRollback: true,
    rejectFirstMergeForCapacity: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)

  await expect(
    page.getByRole("heading", { name: "正在确认合并结果" }),
  ).toBeVisible()
  expect((await persistedUser(page))?.id).toBe(mock.anonymousUserId)
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      "studytrace.pending-account-merge-recovery.v1",
    ),
  ).not.toBeNull()

  await page.reload()

  await expect(
    page.getByText("合并后的记录数量会超过当前上限，请先清理部分历史记录"),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "输入邮件中的六位数字" }),
  ).toBeVisible()
  await expect
    .poll(async () => (await persistedUser(page))?.id)
    .toBe(mock.anonymousUserId)
  await expect(page.getByRole("button", { name: "更换邮箱" })).toBeVisible()
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      "studytrace.pending-account-merge-recovery.v1",
    ),
  ).toBeNull()
})

test("合并容量明确失败时恢复原匿名会话并保留取消能力", async ({ page }) => {
  const email = "capacity-rollback@example.com"
  const mock = await installMockSupabase(page, {
    existingAccountEmails: [email],
    rejectFirstMergeForCapacity: true,
  })

  await page.goto("/auth")
  await sendEmailCode(page, email)
  await page.getByRole("button", { name: "确认并发送验证码" }).click()
  await finishOtp(page)

  await expect(
    page.getByText("合并后的记录数量会超过当前上限，请先清理部分历史记录"),
  ).toBeVisible()
  await expect
    .poll(async () => (await persistedUser(page))?.id)
    .toBe(mock.anonymousUserId)
  expect((await persistedUser(page))?.is_anonymous).toBe(true)

  await page.getByRole("button", { name: "更换邮箱" }).click()
  await expect(
    page.getByText("已取消本次验证，可以立即重新发起。"),
  ).toBeVisible()
  expect(mock.authEvents).toContain("cancel-merge")
})

test("取消删除验证后可以立即重新准备新的删除请求", async ({ page }) => {
  const mock = await installMockSupabase(page, {
    accountKind: "permanent",
    accountEmail: "cancel-delete@example.com",
  })

  await page.goto("/auth")
  await page.getByRole("button", { name: "删除账号与全部记录" }).click()
  await page.getByRole("button", { name: "继续验证" }).click()
  await expect(
    page.getByRole("heading", { name: "验证后永久删除" }),
  ).toBeVisible()

  await page.getByRole("button", { name: "取消删除" }).click()
  await expect(
    page.getByText("已取消本次验证，可以立即重新发起。"),
  ).toBeVisible()
  expect(mock.authEvents).toContain("cancel-deletion")

  await page.getByRole("button", { name: "删除账号与全部记录" }).click()
  await page.getByRole("button", { name: "继续验证" }).click()
  await expect(
    page.getByRole("heading", { name: "验证后永久删除" }),
  ).toBeVisible()
  expect(
    mock.authEvents.filter((event) => event === "prepare-deletion"),
  ).toHaveLength(2)
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

test("过期或篡改的 durable capability 会被擦除，但非敏感核对标记保留", async ({
  page,
}) => {
  const mock = await installMockSupabase(page, {
    existingAccountEmails: ["expired-durable@example.com"],
  })
  await page.addInitScript(
    ({ durableKey, markerKey, sourceUserId, targetUserId }) => {
      localStorage.setItem(
        durableKey,
        JSON.stringify({
          sourceUserId,
          targetUserId,
          email: "expired-durable@example.com",
          mergeSecret: "f".repeat(64),
          preparedAt: Date.now() - 10 * 60_000 - 1,
        }),
      )
      localStorage.setItem(
        markerKey,
        JSON.stringify({
          sourceUserId,
          targetUserId,
          email: "expired-durable@example.com",
          capturedAt: Date.now(),
        }),
      )
    },
    {
      durableKey: durableMergeStorageKey,
      markerKey: mergeHandoffStorageKey,
      sourceUserId: mock.anonymousUserId,
      targetUserId: mock.permanentUserId,
    },
  )

  await page.goto("/auth")
  await expect
    .poll(() =>
      page.evaluate(
        ({ durableKey, markerKey }) => ({
          durable: localStorage.getItem(durableKey),
          marker: localStorage.getItem(markerKey),
        }),
        {
          durableKey: durableMergeStorageKey,
          markerKey: mergeHandoffStorageKey,
        },
      ),
    )
    .toMatchObject({ durable: null, marker: expect.any(String) })
})
