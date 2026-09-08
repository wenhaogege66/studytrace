import { execFile, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"

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
const execFileAsync = promisify(execFile)

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

async function runPsql(sql: string) {
  return execFileAsync(
    "psql",
    [databaseUrl, "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  )
}

function authClaimsSql(userId: string, sessionId: string, method: string) {
  return `
    select set_config('request.jwt.claim.sub', '${validateUserId(userId)}', true);
    select set_config('request.jwt.claim.role', 'authenticated', true);
    select set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub', '${validateUserId(userId)}',
        'role', 'authenticated',
        'session_id', '${validateUserId(sessionId)}',
        'amr', jsonb_build_array(
          jsonb_build_object(
            'method', '${method}',
            'timestamp', extract(epoch from clock_timestamp())::bigint
          )
        )
      )::text,
      true
    );
  `
}

function authUserFixtureSql({
  sourceUserId,
  targetUserId,
  targetEmail,
  sourceSessionId,
  targetSessionId,
}: {
  sourceUserId?: string
  targetUserId: string
  targetEmail: string
  sourceSessionId?: string
  targetSessionId: string
}) {
  return `
    insert into auth.users (
      id, aud, role, email, encrypted_password, raw_app_meta_data,
      raw_user_meta_data, is_anonymous, email_confirmed_at,
      last_sign_in_at, created_at, updated_at
    ) values
      ${
        sourceUserId
          ? `(
        '${validateUserId(sourceUserId)}', 'authenticated', 'authenticated',
        null, '', '{"provider":"anonymous","providers":["anonymous"]}',
        '{}', true, null, now(), now(), now()
      ),`
          : ""
      }
      (
        '${validateUserId(targetUserId)}', 'authenticated', 'authenticated',
        '${targetEmail}', '', '{"provider":"email","providers":["email"]}',
        '{}', false, now(), now(), now(), now()
      );
    insert into auth.sessions (id, user_id, created_at, updated_at) values
      ${
        sourceUserId && sourceSessionId
          ? `('${validateUserId(sourceSessionId)}', '${validateUserId(sourceUserId)}', now(), now()),`
          : ""
      }
      ('${validateUserId(targetSessionId)}', '${validateUserId(targetUserId)}', now(), now());
    insert into public.user_settings (user_id) values
      ${sourceUserId ? `('${validateUserId(sourceUserId)}'),` : ""}
      ('${validateUserId(targetUserId)}');
  `
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

    // Cancel must revoke the prepared database bearer, not merely clear this
    // tab's sessionStorage. The same anonymous identity can restart at once.
    await waitForOtp(request, email, seenMessageIds)
    await page.getByRole("button", { name: "更换邮箱" }).click()
    await expect(
      page.getByText("已取消本次验证，可以立即重新发起。"),
    ).toBeVisible()
    expect(
      databaseCount(
        `select count(*) from private.account_merge_tokens where source_user_id = '${validateUserId(sourceUserId)}'::uuid;`,
      ),
    ).toBe(0)

    allowImmediateOtp(targetUserId)
    await sendEmailCode(page, email)
    await page.getByRole("button", { name: "确认并发送验证码" }).click()
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

test("真实 Auth：合并提交后响应丢失，同一目标 Session 可恢复原回执", async ({
  page,
  request,
}) => {
  const email = `receipt-${randomUUID()}@studytrace.local`
  const seenMessageIds = new Set<string>()
  let sourceUserId: string | undefined
  let targetUserId: string | undefined
  let loseResponse = true

  try {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (created.error || !created.data.user) {
      throw created.error ?? new Error("无法创建本地回执目标账号")
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
    await page.getByRole("button", { name: "确认并发送验证码" }).click()

    await page.route(
      `${apiUrl}/rest/v1/rpc/consume_account_merge`,
      async (route) => {
        if (!loseResponse) {
          await route.continue()
          return
        }
        loseResponse = false
        const committed = await route.fetch()
        expect(committed.ok()).toBe(true)
        await route.abort("failed")
      },
    )

    await enterOtp(page, await waitForOtp(request, email, seenMessageIds))
    await expect(
      page.getByRole("alert").filter({ hasText: "网络连接失败" }),
    ).toBeVisible()
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
    expect(
      databaseCount(
        `select count(*) from private.account_merge_tokens where target_user_id = '${validateUserId(targetUserId)}'::uuid and merge_state = 'consumed';`,
      ),
    ).toBe(1)

    await page.reload()

    await expect(
      page.getByRole("heading", { name: "账号与同步" }),
    ).toBeVisible()
    await expect(page.getByText("邮箱账号已恢复，记录同步完成。")).toBeVisible()
    await expect(page.getByText("原匿名记录已合并")).toBeVisible()
  } finally {
    await deleteTestUsers(sourceUserId, targetUserId)
  }
})

test("真实 Auth：合并提交后关闭标签页，可重新验证目标邮箱恢复记录", async ({
  page,
  context,
  request,
}) => {
  const email = `closed-tab-${randomUUID()}@studytrace.local`
  const seenMessageIds = new Set<string>()
  let sourceUserId: string | undefined
  let targetUserId: string | undefined
  let loseResponse = true

  try {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    })
    if (created.error || !created.data.user) {
      throw created.error ?? new Error("无法创建本地关闭标签恢复目标账号")
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
    await page.getByRole("button", { name: "确认并发送验证码" }).click()

    await page.route(
      `${apiUrl}/rest/v1/rpc/consume_account_merge`,
      async (route) => {
        if (!loseResponse) {
          await route.continue()
          return
        }
        loseResponse = false
        const committed = await route.fetch()
        expect(committed.ok()).toBe(true)
        await route.abort("failed")
      },
    )
    await enterOtp(page, await waitForOtp(request, email, seenMessageIds))
    await expect(
      page.getByRole("alert").filter({ hasText: "网络连接失败" }),
    ).toBeVisible()
    expect(
      databaseCount(
        `select count(*) from auth.users where id = '${validateUserId(sourceUserId)}'::uuid;`,
      ),
    ).toBe(0)

    await page.close()
    const restoredPage = await context.newPage()
    await restoredPage.goto("/auth")
    await expect(restoredPage.getByLabel("邮箱")).toHaveValue(email)
    await expect(restoredPage.getByText(/上次匿名身份已失效/)).toBeVisible()

    allowImmediateOtp(targetUserId)
    await sendEmailCode(restoredPage, email)
    await enterOtp(
      restoredPage,
      await waitForOtp(request, email, seenMessageIds),
    )
    await expect(
      restoredPage.getByRole("heading", { name: "账号与同步" }),
    ).toBeVisible()
    const restoredUser = await readStoredUser(restoredPage)
    expect(restoredUser.id).toBe(targetUserId)
    expect(
      databaseCount(
        `select count(*) from public.tasks where user_id = '${validateUserId(targetUserId)}'::uuid;`,
      ),
    ).toBe(2)
    expect(
      await restoredPage.evaluate(() =>
        localStorage.getItem("studytrace.pending-account-merge-durable.v2"),
      ),
    ).toBeNull()
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

    await waitForOtp(request, email, seenMessageIds)
    await page.getByRole("button", { name: "取消删除" }).click()
    await expect(
      page.getByText("已取消本次验证，可以立即重新发起。"),
    ).toBeVisible()
    expect(
      databaseCount(
        `select count(*) from private.account_delete_tokens where user_id = '${validateUserId(deletingUserId)}'::uuid;`,
      ),
    ).toBe(0)

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

test("真实双连接：任务写入与账号合并按 owner-first 顺序串行且无死锁", async () => {
  const sourceUserId = randomUUID()
  const targetUserId = randomUUID()
  const sourceSessionId = randomUUID()
  const targetSessionId = randomUUID()
  const insertedTaskId = randomUUID()
  const targetEmail = `lock-merge-${randomUUID()}@studytrace.local`
  const mergeSecret = randomUUID().replaceAll("-", "").repeat(2)

  try {
    await runPsql(
      authUserFixtureSql({
        sourceUserId,
        targetUserId,
        targetEmail,
        sourceSessionId,
        targetSessionId,
      }),
    )
    await runPsql(`
      begin;
      set local role authenticated;
      ${authClaimsSql(sourceUserId, sourceSessionId, "anonymous")}
      select public.prepare_account_merge('${mergeSecret}', '${targetEmail}');
      commit;
    `)

    const writer = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      set local role authenticated;
      ${authClaimsSql(targetUserId, targetSessionId, "otp")}
      insert into public.tasks (
        id, user_id, title, steps, priority, estimated_minutes
      ) values (
        '${insertedTaskId}', '${targetUserId}', '并发写入',
        '[{"id":"lock-step","title":"完成","completed":false}]',
        'medium', 10
      );
      select pg_sleep(0.75);
      commit;
    `)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const mergeStartedAt = Date.now()
    const merger = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      set local role authenticated;
      ${authClaimsSql(targetUserId, targetSessionId, "otp")}
      select public.consume_account_merge('${mergeSecret}');
      commit;
    `)
    await Promise.all([writer, merger])

    expect(Date.now() - mergeStartedAt).toBeGreaterThanOrEqual(500)
    expect(
      databaseCount(
        `select count(*) from auth.users where id = '${sourceUserId}'::uuid;`,
      ),
    ).toBe(0)
    expect(
      databaseCount(
        `select count(*) from public.tasks where id = '${insertedTaskId}'::uuid and user_id = '${targetUserId}'::uuid;`,
      ),
    ).toBe(1)
  } finally {
    await deleteTestUsers(sourceUserId, targetUserId)
  }
})

test("真实双连接：设置写入与账号删除按同一 owner 锁串行且无死锁", async () => {
  const userId = randomUUID()
  const prepareSessionId = randomUUID()
  const deleteSessionId = randomUUID()
  const email = `lock-delete-${randomUUID()}@studytrace.local`
  const deletionSecret = randomUUID().replaceAll("-", "").repeat(2)

  try {
    await runPsql(
      authUserFixtureSql({
        targetUserId: userId,
        targetEmail: email,
        targetSessionId: prepareSessionId,
      }),
    )
    await runPsql(`
      insert into auth.sessions (id, user_id, created_at, updated_at)
      values ('${deleteSessionId}', '${userId}', now(), now());
      begin;
      set local role authenticated;
      ${authClaimsSql(userId, prepareSessionId, "password")}
      select public.prepare_account_deletion('${deletionSecret}');
      commit;
    `)

    const writer = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      set local role authenticated;
      ${authClaimsSql(userId, prepareSessionId, "password")}
      update public.user_settings
      set reminders_enabled = not reminders_enabled
      where user_id = '${userId}'::uuid;
      select pg_sleep(0.75);
      commit;
    `)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const deletionStartedAt = Date.now()
    const deletion = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      set local role authenticated;
      ${authClaimsSql(userId, deleteSessionId, "otp")}
      select public.delete_my_account('${deletionSecret}');
      commit;
    `)
    await Promise.all([writer, deletion])

    expect(Date.now() - deletionStartedAt).toBeGreaterThanOrEqual(500)
    expect(
      databaseCount(
        `select count(*) from auth.users where id = '${userId}'::uuid;`,
      ),
    ).toBe(0)
  } finally {
    await deleteTestUsers(userId)
  }
})

test("真实双连接：活动更新时间与匿名清理串行后重新核验活跃度", async () => {
  const userId = randomUUID()
  const sessionId = randomUUID()

  try {
    await runPsql(`
      insert into auth.users (
        id, aud, role, email, encrypted_password, raw_app_meta_data,
        raw_user_meta_data, is_anonymous, last_sign_in_at, created_at, updated_at
      ) values (
        '${userId}', 'authenticated', 'authenticated', null, '',
        '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
        now() - interval '40 days', now() - interval '40 days',
        now() - interval '40 days'
      );
      insert into auth.sessions (id, user_id, created_at, updated_at)
      values ('${sessionId}', '${userId}', now(), now());
      update private.user_activity
      set last_active_at = now() - interval '40 days'
      where user_id = '${userId}'::uuid;
    `)

    const toucher = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      set local role authenticated;
      ${authClaimsSql(userId, sessionId, "anonymous")}
      select public.touch_my_activity();
      select pg_sleep(0.75);
      commit;
    `)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const cleanupStartedAt = Date.now()
    const cleanup = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      select private.cleanup_expired_anonymous_users();
      commit;
    `)
    await Promise.all([toucher, cleanup])

    expect(Date.now() - cleanupStartedAt).toBeGreaterThanOrEqual(500)
    expect(
      databaseCount(
        `select count(*) from auth.users where id = '${userId}'::uuid;`,
      ),
    ).toBe(1)
    expect(
      databaseCount(
        `select count(*) from private.user_activity where user_id = '${userId}'::uuid and last_active_at > now() - interval '1 minute';`,
      ),
    ).toBe(1)
  } finally {
    await deleteTestUsers(userId)
  }
})

test("真实双连接：准备账号合并会刷新活跃度并阻止临界匿名清理", async () => {
  const sourceUserId = randomUUID()
  const targetUserId = randomUUID()
  const sourceSessionId = randomUUID()
  const targetSessionId = randomUUID()
  const targetEmail = `prepare-cleanup-${randomUUID()}@studytrace.local`
  const mergeSecret = randomUUID().replaceAll("-", "").repeat(2)

  try {
    await runPsql(
      authUserFixtureSql({
        sourceUserId,
        targetUserId,
        targetEmail,
        sourceSessionId,
        targetSessionId,
      }),
    )
    await runPsql(`
      update auth.users
      set last_sign_in_at = now() - interval '40 days',
          created_at = now() - interval '40 days',
          updated_at = now() - interval '40 days'
      where id = '${sourceUserId}'::uuid;
      update private.user_activity
      set last_active_at = now() - interval '40 days'
      where user_id = '${sourceUserId}'::uuid;
    `)

    const preparer = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      set local role authenticated;
      ${authClaimsSql(sourceUserId, sourceSessionId, "anonymous")}
      select public.prepare_account_merge('${mergeSecret}', '${targetEmail}');
      select pg_sleep(0.75);
      commit;
    `)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const cleanupStartedAt = Date.now()
    const cleanup = runPsql(`
      begin;
      set local statement_timeout = '8s';
      set local lock_timeout = '6s';
      select private.cleanup_expired_anonymous_users();
      commit;
    `)
    await Promise.all([preparer, cleanup])

    expect(Date.now() - cleanupStartedAt).toBeGreaterThanOrEqual(500)
    expect(
      databaseCount(
        `select count(*) from auth.users where id = '${sourceUserId}'::uuid;`,
      ),
    ).toBe(1)
    expect(
      databaseCount(
        `select count(*) from private.account_merge_tokens where source_user_id = '${sourceUserId}'::uuid and merge_state = 'prepared';`,
      ),
    ).toBe(1)
    expect(
      databaseCount(
        `select count(*) from private.user_activity where user_id = '${sourceUserId}'::uuid and last_active_at > now() - interval '1 minute';`,
      ),
    ).toBe(1)
  } finally {
    await deleteTestUsers(sourceUserId, targetUserId)
  }
})
