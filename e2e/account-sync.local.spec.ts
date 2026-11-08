import { randomUUID } from "node:crypto"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { expect, test, type Page } from "@playwright/test"

const apiUrl = process.env.STUDYTRACE_LOCAL_API_URL ?? ""
const secretKey = process.env.STUDYTRACE_LOCAL_SECRET_KEY ?? ""
const publicKey = process.env.STUDYTRACE_LOCAL_PUBLISHABLE_KEY ?? ""
const password = "studytrace-local-test-password"
let admin: SupabaseClient
const createdUsers = new Set<string>()

test.beforeAll(() => {
  if (
    process.env.STUDYTRACE_LOCAL_AUTH_E2E !== "true" ||
    !apiUrl.startsWith("http://127.0.0.1:") ||
    !secretKey ||
    !publicKey
  )
    throw new Error("Only run via the isolated local-auth config")
  admin = createClient(apiUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})
test.afterEach(async () => {
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id)
  createdUsers.clear()
})
async function readSession(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (key) => key.startsWith("sb-") && key.endsWith("-auth-token"),
    )
    return key ? JSON.parse(localStorage.getItem(key) ?? "null") : null
  })
}
async function startAnonymous(page: Page) {
  await page.goto("/app")
  await page.getByRole("checkbox").first().check()
  await page.getByRole("button", { name: "开始体验" }).click()
  await expect(
    page.getByRole("button", { name: "新建任务" }).first(),
  ).toBeVisible()
  const session = await readSession(page)
  createdUsers.add(session.user.id)
  return session
}
async function register(page: Page, email: string) {
  await page.goto("/auth")
  await page.getByRole("button", { name: "注册", exact: true }).click()
  await page.getByLabel("邮箱", { exact: true }).fill(email)
  await page.getByLabel("密码", { exact: true }).fill(password)
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "注册并进入学习计划" }).click()
  await expect(page).toHaveURL(/\/app$/)
  const session = await readSession(page)
  createdUsers.add(session.user.id)
  return session
}

test("真实 Auth：无邮件注册独立账号，匿名数据保持隔离，错误密码不切换", async ({
  page,
}) => {
  const source = await startAnonymous(page)
  const anon = createClient(apiUrl, publicKey, {
    auth: { persistSession: false },
  })
  await anon.auth.setSession(source)
  const { data: task, error } = await anon
    .from("tasks")
    .insert({
      user_id: source.user.id,
      title: "匿名专属计划",
      estimated_minutes: 25,
      steps: [{ id: "one", title: "独立步骤", completed: false }],
      priority: "medium",
      status: "planned",
    })
    .select()
    .single()
  expect(error).toBeNull()
  const email = `local-${randomUUID()}@example.com`
  const account = await register(page, email)
  expect(account.user.id).not.toBe(source.user.id)
  expect(account.user.is_anonymous).toBe(false)
  const signedIn = createClient(apiUrl, publicKey, {
    auth: { persistSession: false },
  })
  await signedIn.auth.setSession(account)
  const { data: other } = await signedIn
    .from("tasks")
    .select()
    .eq("id", task.id)
  expect(other).toEqual([])
  expect(
    (await anon.from("tasks").select().eq("id", task.id)).data,
  ).toHaveLength(1)
  await page.goto("/auth")
  await page.getByRole("button", { name: "退出账号" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await page.goto("/auth")
  await page.getByLabel("邮箱", { exact: true }).fill(email)
  await page.getByLabel("密码", { exact: true }).fill("wrong-password")
  await page.getByRole("button", { name: "登录并进入学习计划" }).click()
  await expect(
    page.getByRole("region", { name: "账号操作" }).getByRole("alert"),
  ).toContainText("邮箱或密码")
  expect(await readSession(page)).toBeNull()
  await page.getByLabel("密码", { exact: true }).fill(password)
  await page.getByRole("button", { name: "登录并进入学习计划" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect((await readSession(page)).user.id).toBe(account.user.id)
})

test("真实 Auth：密码新鲜会话注销本人；错误密码不删除", async ({ page }) => {
  const session = await register(page, `delete-${randomUUID()}@example.com`)
  await page.goto("/auth")
  await page.getByRole("button", { name: "永久删除账号与记录" }).click()
  await page.getByLabel("再次输入密码").fill("wrong-password")
  await page.getByRole("checkbox").check()
  await page.getByRole("button", { name: "验证密码并永久删除" }).click()
  await expect(
    page.getByRole("region", { name: "账号操作" }).getByRole("alert"),
  ).toContainText("邮箱或密码")
  expect(
    (await admin.auth.admin.getUserById(session.user.id)).data.user?.id,
  ).toBe(session.user.id)
  await page.getByLabel("再次输入密码").fill(password)
  await page.getByRole("button", { name: "验证密码并永久删除" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect(
    (await admin.auth.admin.getUserById(session.user.id)).data.user,
  ).toBeNull()
  expect(await readSession(page)).toBeNull()
})
