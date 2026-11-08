import { expect, test } from "@playwright/test"

import { manualLearningPlan } from "../src/lib/planning/manual"
import { installMockSupabase } from "./mock-supabase"
import { createManualPlan } from "./plan-actions"

test("具体意图、一次修改点评、观察约定与实际采用版本一致", async ({
  page,
}, testInfo) => {
  await installMockSupabase(page)
  const recommended = manualLearningPlan("用 25 分钟复习五道数学错题")
  let reviews = 0
  let saved: Record<string, unknown> | null = null
  await page.route("**/api/planning/prepare", (route) =>
    route.fulfill({ json: { kind: "plan", plan: recommended } }),
  )
  await page.route("**/api/planning/review", (route) => {
    reviews++
    return route.fulfill({
      json: {
        comment: "本次投入缩短为十五分钟，可以先处理前两道错题，检查后再继续。",
        reason: "这是执行范围的调整，不代表对个人状态的判断。",
        suggestion: null,
      },
    })
  })
  await page.route("**/rest/v1/rpc/save_learning_plan", async (route) => {
    saved = route.request().postDataJSON()
    const plan = saved!.p_plan as typeof recommended
    await route.fulfill({
      json: {
        id: crypto.randomUUID(),
        user_id: "e2e00000-0000-4000-8000-000000000001",
        title: plan.title,
        steps: plan.steps,
        priority: plan.priority,
        estimated_minutes: plan.estimatedMinutes,
        observation_profile: plan.observationProfile,
        observation_agreement: plan.observationAgreement,
        status: "planned",
        completed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    })
  })
  await page.goto("/app/plans/new")
  await page.getByLabel("学习意图", { exact: true }).fill(recommended.intent)
  await page.getByRole("button", { name: "生成推荐方案" }).click()
  await expect(page.getByLabel("学习计划名称")).toHaveValue(recommended.title)
  await page.getByLabel("本次建议（分钟）").fill("15")
  await page.getByRole("button", { name: "确认方案" }).click()
  await expect(
    page.getByRole("heading", { name: "一次修改点评" }),
  ).toBeVisible()
  expect(reviews).toBe(1)
  await page.getByRole("button", { name: "保留我的方案" }).click()
  await page.getByLabel("手机", { exact: true }).selectOption("allowed")
  await page.getByRole("button", { name: "返回修改" }).click()
  await page.getByLabel("整个计划预计（分钟）").fill("50")
  await page.getByRole("button", { name: "确认方案" }).click()
  await expect(
    page.getByRole("heading", { name: "确认观察约定。" }),
  ).toBeVisible()
  expect(reviews).toBe(1)
  await page.reload()
  await expect(page.getByLabel("手机", { exact: true })).toHaveValue("allowed")
  expect(reviews).toBe(1)
  await page.screenshot({
    path: `output/playwright/planning-agreement-${testInfo.project.name}.png`,
    fullPage: true,
  })
  await page.getByRole("button", { name: "保存学习计划" }).click()
  await expect(page).toHaveURL(/\/app$/)
  expect(saved).not.toBeNull()
  const payload = saved as unknown as {
    p_plan: typeof recommended
    p_revisions: { kind: string; snapshot: typeof recommended }[]
  }
  expect(payload.p_plan.estimatedMinutes).toBe(50)
  expect(payload.p_plan.sessionMinutes).toBe(15)
  expect(payload.p_plan.observationAgreement.phone).toBe("allowed")
  expect(payload.p_revisions.map((revision) => revision.kind)).toEqual([
    "ai_initial",
    "user_edit",
    "ai_review",
  ])
  expect(payload.p_revisions[1].snapshot.sessionMinutes).toBe(15)
})

test("宽泛意图只显示相关依赖选项，切换后清除失效回答并可跳过", async ({
  page,
}, testInfo) => {
  await installMockSupabase(page)
  const calls: Record<string, unknown>[] = []
  await page.route("**/api/planning/prepare", (route) => {
    const input = route.request().postDataJSON()
    calls.push(input)
    return route.fulfill({
      json:
        calls.length === 1
          ? {
              kind: "questions",
              explanation: "先明确范围",
              questions: [
                {
                  id: "stage",
                  prompt: "目前的学段？",
                  options: [
                    { value: "junior", label: "初中" },
                    { value: "senior", label: "高中" },
                  ],
                  dependsOn: null,
                },
                {
                  id: "grade",
                  prompt: "高中的哪一年？",
                  options: [
                    { value: "one", label: "高一" },
                    { value: "two", label: "高二" },
                  ],
                  dependsOn: { questionId: "stage", value: "senior" },
                },
                {
                  id: "unit",
                  prompt: "先复习哪部分？",
                  options: [
                    { value: "function", label: "函数" },
                    { value: "equation", label: "方程" },
                  ],
                  dependsOn: { questionId: "grade", value: "one" },
                },
              ],
            }
          : {
              kind: "plan",
              plan: manualLearningPlan(input.intent, 25, input.answers),
            },
    })
  })
  await page.goto("/app/plans/new")
  await page.getByLabel("学习意图", { exact: true }).fill("我想复习数学")
  await page.getByRole("button", { name: "生成推荐方案" }).click()
  await expect(page.getByText("高中的哪一年？", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "高中", exact: true }).click()
  await page.getByRole("button", { name: "高一", exact: true }).click()
  await page.getByRole("button", { name: "函数", exact: true }).click()
  await page.getByRole("button", { name: "初中", exact: true }).click()
  await expect(page.getByText("高中的哪一年？", { exact: true })).toHaveCount(0)
  await expect(page.getByText("先复习哪部分？", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "按现有信息生成" }).click()
  await expect(page.getByLabel("学习计划名称")).toBeVisible()
  expect(calls[1].answers).toEqual({ stage: "junior" })
  expect(calls[1].forceGenerate).toBe(true)
  await page.screenshot({
    path: `output/playwright/planning-plan-${testInfo.project.name}.png`,
    fullPage: true,
  })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(overflow).toBe(false)
})

test("推荐未修改不调用复核，AI 失败后仍能手动制定", async ({ page }) => {
  await installMockSupabase(page)
  let reviews = 0
  await page.route("**/api/planning/prepare", (route) =>
    route.fulfill({ status: 503, json: { error: "额度不足，可手动制定" } }),
  )
  await page.route("**/api/planning/review", (route) => {
    reviews++
    return route.abort()
  })
  await page.goto("/app/plans/new")
  await page.getByLabel("学习意图", { exact: true }).fill("复习五道错题")
  await page.getByRole("button", { name: "生成推荐方案" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "额度不足" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "手动制定", exact: true }).click()
  await page.getByRole("button", { name: "确认方案" }).click()
  await expect(page.getByLabel("学习方式")).toBeVisible()
  expect(reviews).toBe(0)
})

test("空状态入口进入引导页，保存后学习关联采用版本与本次安排", async ({
  page,
}) => {
  const mock = await installMockSupabase(page)
  await page.goto("/app")
  await page
    .getByRole("heading", { name: "学习计划还是空的" })
    .locator("..")
    .getByRole("button", { name: "制定计划" })
    .click()
  await expect(page).toHaveURL(/\/app\/plans\/new/)
  await page.getByRole("link", { name: "学迹学习计划首页" }).click()
  await createManualPlan(page, "检查采用版本后的学习安排", ["阅读并记录"], 40)
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
  const session = mock.studySessions()[0]
  expect(session.plan_revision_id).toEqual(expect.any(String))
  expect(session.target_minutes).toBe(25)
  expect(session.observation_agreement).toMatchObject({
    phone: "ignored",
    tablet: "ignored",
  })
  await expect(page.getByText(/已关联采用方案/)).toBeVisible()
  await page.locator("summary").filter({ hasText: "本次安排" }).click()
  await page.getByLabel("目标分钟", { exact: true }).fill("18")
  await page.getByLabel("开始时的主观精力（可选）").selectOption("steady")
  await page.getByRole("button", { name: "保存本次安排" }).click()
  await expect(page.getByText("本次学习安排已保存")).toBeVisible()
  expect(mock.studySessions()[0]).toMatchObject({
    target_minutes: 18,
    energy_before: "steady",
    plan_revision_id: session.plan_revision_id,
  })
})
