import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js"
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test"

type MailpitMessage = {
  ID: string
  To?: unknown
}

type MailpitList = {
  messages?: MailpitMessage[]
}

const apiUrl = process.env.STUDYTRACE_LOCAL_API_URL ?? ""
const databaseUrl = process.env.STUDYTRACE_LOCAL_DB_URL ?? ""
const mailpitUrl = process.env.STUDYTRACE_LOCAL_MAILPIT_URL ?? ""
const secretKey = process.env.STUDYTRACE_LOCAL_SECRET_KEY ?? ""
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let admin: SupabaseClient

test.beforeAll(() => {
  if (
    process.env.STUDYTRACE_LOCAL_AUTH_E2E !== "true" ||
    !apiUrl ||
    !databaseUrl ||
    !mailpitUrl ||
    !secretKey
  ) {
    throw new Error(
      "请使用 playwright.local-auth.config.ts 在已启动的本地 Supabase 上运行此测试",
    )
  }
  admin = createClient(apiUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})

async function beginAnonymousExperience(page: Page) {
  await page.goto("/app")
  await page
    .getByLabel("我理解匿名数据不可跨设备恢复，并同意仅保存结构化学习记录。")
    .check()
  await page.getByRole("button", { name: "开始体验" }).click()
  await expect(
    page.getByRole("heading", { name: "今天，先完成哪一件具体的事？" }),
  ).toBeVisible()
}

async function readStoredUser(page: Page): Promise<User> {
  const user = await page.evaluate(() => {
    const storageKey = Object.keys(window.localStorage).find(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    )
    if (!storageKey) return null
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    return (JSON.parse(raw) as { user?: unknown }).user ?? null
  })
  expect(user).not.toBeNull()
  return user as User
}

async function sendEmailCode(page: Page, email: string) {
  await page.getByLabel("邮箱").fill(email)
  await page.getByRole("button", { name: "发送验证码" }).click()
}

async function enterOtp(page: Page, code: string) {
  await page.getByLabel("验证码").fill(code)
  await page.getByRole("button", { name: "完成验证" }).click()
}

async function waitForOtp(
  request: APIRequestContext,
  email: string,
  seenMessageIds: Set<string>,
) {
  let capturedId = ""
  let capturedCode = ""

  await expect
    .poll(
      async () => {
        const listResponse = await request.get(`${mailpitUrl}/api/v1/messages`)
        if (!listResponse.ok()) return ""
        const list = (await listResponse.json()) as MailpitList
        const message = list.messages?.find(
          (candidate) =>
            !seenMessageIds.has(candidate.ID) &&
            JSON.stringify(candidate.To ?? "")
              .toLocaleLowerCase("en-US")
              .includes(email.toLocaleLowerCase("en-US")),
        )
        if (!message) return ""

        const detailResponse = await request.get(
          `${mailpitUrl}/api/v1/message/${encodeURIComponent(message.ID)}`,
        )
        if (!detailResponse.ok()) return ""
        const detail = (await detailResponse.json()) as Record<string, unknown>
        const textContent = typeof detail.Text === "string" ? detail.Text : ""
        const htmlContent = typeof detail.HTML === "string" ? detail.HTML : ""
        const code =
          textContent.match(/(?:^|\r?\n)\s*(\d{6})\s*(?=\r?\n|$)/m)?.[1] ??
          htmlContent.match(/>\s*(\d{6})\s*</)?.[1]
        if (!code) return ""
        capturedId = message.ID
        capturedCode = code
        return code
      },
      { timeout: 15_000, intervals: [200, 300, 500, 1_000] },
    )
    .toMatch(/^\d{6}$/)

  if (!capturedId || !capturedCode)
    throw new Error(`未能读取 ${email} 的本地验证码`)
  seenMessageIds.add(capturedId)
  return capturedCode
}

function validateUserId(userId: string) {
  if (!uuidPattern.test(userId)) throw new Error("测试用户 ID 不是有效 UUID")
  return userId
}

function allowImmediateOtp(userId: string) {
  const safeUserId = validateUserId(userId)
  execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-q"], {
    encoding: "utf8",
    input: `
      update auth.users
      set confirmation_sent_at = clock_timestamp() - interval '2 minutes',
          email_change_sent_at = clock_timestamp() - interval '2 minutes',
          recovery_sent_at = clock_timestamp() - interval '2 minutes'
      where id = '${safeUserId}'::uuid;
    `,
  })
}

function databaseCount(sql: string) {
  return Number(
    execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-Atq"], {
      encoding: "utf8",
      input: sql,
    }).trim(),
  )
}

async function deleteTestUsers(...userIds: Array<string | undefined>) {
  for (const userId of new Set(userIds.filter(Boolean))) {
    if (!userId || !uuidPattern.test(userId)) continue
    await admin.auth.admin.deleteUser(userId)
  }
}

test("真实 Auth：匿名身份绑定新邮箱后保持 user_id，退出后可验证码恢复", async ({
  page,
  request,
}) => {
  const email = `upgrade-${randomUUID()}@studytrace.local`
  const seenMessageIds = new Set<string>()
  let accountUserId: string | undefined

  try {
    await beginAnonymousExperience(page)
    const anonymousUser = await readStoredUser(page)
    accountUserId = anonymousUser.id
    expect(anonymousUser.is_anonymous).toBe(true)

    await page
      .getByRole("link", {
        name: "临时记录，仅此浏览器；前往保存并同步",
      })
      .click()
    await sendEmailCode(page, email)
    await expect(
      page.getByRole("heading", { name: "输入邮件中的六位数字" }),
    ).toBeVisible()
    await enterOtp(page, await waitForOtp(request, email, seenMessageIds))

    await expect(
      page.getByRole("heading", { name: "账号与同步" }),
    ).toBeVisible()
    const upgradedUser = await readStoredUser(page)
    expect(upgradedUser.id).toBe(anonymousUser.id)
    expect(upgradedUser.is_anonymous).toBe(false)
    expect(upgradedUser.email).toBe(email)

    await page.getByRole("button", { name: "退出当前设备" }).click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("button", { name: "开始体验" })).toBeVisible()

    allowImmediateOtp(upgradedUser.id)
    await page.goto("/auth")
    await expect(
      page.getByRole("heading", { name: "恢复已有记录" }),
    ).toBeVisible()
    await sendEmailCode(page, email)
    await enterOtp(page, await waitForOtp(request, email, seenMessageIds))

    await expect(
      page.getByRole("heading", { name: "账号与同步" }),
    ).toBeVisible()
    const restoredUser = await readStoredUser(page)
    expect(restoredUser.id).toBe(upgradedUser.id)
    expect(restoredUser.is_anonymous).toBe(false)
  } finally {
    await deleteTestUsers(accountUserId)
  }
})

test("真实 Auth：已有邮箱只在确认与 OTP 后合并匿名记录", async ({
  page,
  request,
}) => {
  const email = `merge-${randomUUID()}@studytrace.local`
  const seenMessageIds = new Set<string>()
  let sourceUserId: string | undefined
  let targetUserId: string | undefined

  try {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (created.error || !created.data.user) {
      throw created.error ?? new Error("无法创建本地目标账号")
    }
    targetUserId = created.data.user.id

    await beginAnonymousExperience(page)
    sourceUserId = (await readStoredUser(page)).id
    await page.getByRole("button", { name: "载入示例" }).first().click()
    await expect(page.getByText("完成光合作用实验复盘")).toBeVisible()

    await page
      .getByRole("link", {
        name: "临时记录，仅此浏览器；前往保存并同步",
      })
      .click()
    await sendEmailCode(page, email)
    await expect(
      page.getByRole("heading", { name: "确认合并当前记录" }),
    ).toBeVisible()
    await expect(
      page.getByText("2 个任务 · 0 次学习时段 · 0 次复盘"),
    ).toBeVisible()
    expect(
      databaseCount(
        `select count(*) from public.tasks where user_id = '${validateUserId(sourceUserId)}'::uuid;`,
      ),
    ).toBe(2)
    expect(
      databaseCount(
        `select count(*) from public.tasks where user_id = '${validateUserId(targetUserId)}'::uuid;`,
      ),
    ).toBe(0)

    await page.getByRole("button", { name: "确认并发送验证码" }).click()
    await expect(
      page.getByRole("heading", { name: "输入邮件中的六位数字" }),
    ).toBeVisible()
    expect(
      databaseCount(
        `select count(*) from public.tasks where user_id = '${validateUserId(sourceUserId)}'::uuid;`,
      ),
    ).toBe(2)
    expect(
      databaseCount(
        `select count(*) from public.tasks where user_id = '${validateUserId(targetUserId)}'::uuid;`,
      ),
    ).toBe(0)
    await enterOtp(page, await waitForOtp(request, email, seenMessageIds))

    await expect(page.getByText("原匿名记录已合并")).toBeVisible()
    const mergedUser = await readStoredUser(page)
    expect(mergedUser.id).toBe(targetUserId)
    expect(mergedUser.is_anonymous).toBe(false)
    expect(
      databaseCount(
        `select count(*) from auth.users where id = '${validateUserId(sourceUserId)}'::uuid;`,
      ),
    ).toBe(0)
    expect(
      databaseCount(
        `select count(*) from public.tasks where user_id = '${validateUserId(targetUserId)}'::uuid;`,
      ),
    ).toBe(2)
  } finally {
    await deleteTestUsers(sourceUserId, targetUserId)
  }
})

test("真实 Auth：邮箱二次验证后永久删除账号与全部记录", async ({
  page,
  request,
}) => {
  const email = `delete-${randomUUID()}@studytrace.local`
  const seenMessageIds = new Set<string>()
  let accountUserId: string | undefined

  try {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (created.error || !created.data.user) {
      throw created.error ?? new Error("无法创建本地待删除账号")
    }
    const deletingUserId = created.data.user.id
    accountUserId = deletingUserId

    await page.goto("/auth")
    await sendEmailCode(page, email)
    await enterOtp(page, await waitForOtp(request, email, seenMessageIds))
    await expect(
      page.getByRole("heading", { name: "账号与同步" }),
    ).toBeVisible()

    allowImmediateOtp(deletingUserId)
    await page.getByRole("button", { name: "删除账号与全部记录" }).click()
    await page.getByRole("button", { name: "继续验证" }).click()
    await expect(
      page.getByRole("heading", { name: "验证后永久删除" }),
    ).toBeVisible()
    await page
      .getByLabel("验证码")
      .fill(await waitForOtp(request, email, seenMessageIds))
    await page.getByRole("button", { name: "永久删除账号与全部记录" }).click()

    await expect(page).toHaveURL(/\/app$/)
    await expect(page.getByRole("button", { name: "开始体验" })).toBeVisible()
    await expect
      .poll(() =>
        databaseCount(
          `select count(*) from auth.users where id = '${validateUserId(deletingUserId)}'::uuid;`,
        ),
      )
      .toBe(0)
    accountUserId = undefined
  } finally {
    await deleteTestUsers(accountUserId)
  }
})
