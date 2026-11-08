import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"
import { createManualPlan } from "./plan-actions"
import { manualLearningPlan } from "../src/lib/planning/manual"

test.beforeEach(async ({ page }, testInfo) => {
  await installMockSupabase(page, {
    resumeDelayMs: testInfo.title.includes("待决恢复") ? 1_000 : undefined,
  })
})

test("任务、学习会话、摄像头拒绝与复盘构成完整降级闭环", async ({ page }) => {
  const cameraWrites: string[] = []
  page.on("request", (request) => {
    if (request.url().endsWith("/rest/v1/rpc/set_study_session_camera"))
      cameraWrites.push(request.url())
  })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Camera denied in E2E", "NotAllowedError")
        },
      },
    })
  })

  await page.goto("/app")
  await expect(
    page.getByRole("heading", { name: "今天，先完成哪一件具体的事？" }),
  ).toBeVisible()

  await createManualPlan(page, "完成一次科创问题定义", ["写下可验证的问题"], 20)

  await expect(page.getByText("完成一次科创问题定义")).toBeVisible()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  await expect(
    page.getByRole("heading", { name: "完成一次科创问题定义" }),
  ).toBeVisible()

  await page.locator("summary").filter({ hasText: "本次安排" }).click()
  await page.getByLabel("目标分钟", { exact: true }).fill("18")
  await page.getByLabel("开始时的主观精力（可选）").selectOption("steady")
  await page.getByRole("button", { name: "保存本次安排" }).click()
  await expect(page.getByText("本次学习安排已保存")).toBeVisible()

  await page.getByRole("button", { name: "开启本地观察" }).click()
  await expect(
    page.getByText("你拒绝了摄像头授权。学习计时和手动复盘不会受影响。"),
  ).toBeVisible()

  await page.getByRole("button", { name: "标记刚才偏离了学习计划" }).click()
  await expect(
    page.getByText("已记录一次偏离，仅用于你的共现统计"),
  ).toBeVisible()

  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()
  await page.getByRole("button", { name: "继续" }).click()

  await expect(
    page.getByRole("button", { name: /^确认完成(?:计划)?$/ }),
  ).toHaveCount(0)
  await page.getByRole("checkbox", { name: "写下可验证的问题" }).click()
  await page.getByRole("button", { name: /^确认完成(?:计划)?$/ }).click()
  await expect(
    page.getByRole("heading", {
      name: /^确认完成这个(?:任务|学习计划)？$/,
    }),
  ).toBeVisible()
  await page.getByRole("button", { name: "完成并立即复盘" }).click()
  await expect(page).toHaveURL(/\/app\/review\//, { timeout: 20_000 })
  await expect(
    page.getByRole("heading", { name: "完成一次科创问题定义" }),
  ).toBeVisible()
  await expect(page.getByText("手动标记", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "修正" }).click()
  const correctionDialog = page.getByRole("dialog", { name: "修正这条事件" })
  await correctionDialog.getByRole("combobox").click()
  await page.getByRole("option", { name: "与本次复盘无关" }).click()
  await correctionDialog
    .getByLabel("修正说明（可选）")
    .fill("这是一条用于手动复盘的标记")
  await correctionDialog.getByRole("button", { name: "保存修正" }).click()
  await expect(page.getByText("已修正", { exact: true })).toBeVisible()

  await page.getByLabel("下一次只调整一件事").fill("开始前先写下验证标准")
  await page.getByRole("button", { name: "保存本次复盘" }).click()
  await expect(page.getByText("这次复盘已经保存")).toBeVisible()

  await page.getByRole("link", { name: "回到任务台", exact: true }).click()
  await page.getByRole("button", { name: "已完成 1" }).click()
  await expect(page.getByText("完成一次科创问题定义")).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
  expect(cameraWrites).toEqual([])
})

test("大任务暂停后恢复同一会话，并在完成全部步骤后结束", async ({ page }) => {
  await page.goto("/app")
  await createManualPlan(page, "完成一轮物理总复习", ["复习力学", "复习电磁学"])

  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  const firstSessionUrl = page.url()
  await page.getByRole("checkbox").first().click()
  await expect(page.getByText("1/2")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /^确认完成(?:计划)?$/ }),
  ).toHaveCount(0)

  await page.getByRole("button", { name: "暂停并返回" }).click()
  await expect(page).toHaveURL(/\/app$/)

  await expect(page.getByText("完成一轮物理总复习")).toBeVisible()
  const resumedTaskRow = page
    .getByRole("heading", { name: "完成一轮物理总复习" })
    .locator("xpath=ancestor::*[@data-slot='card'][1]")
  await expect(
    resumedTaskRow.getByText("1/2 步", { exact: true }).last(),
  ).toBeVisible()
  await page.getByRole("button", { name: /^(?:任务|学习计划)操作$/ }).click()
  await expect(
    page.getByRole("menuitem", { name: "本次学习进行中，无法归档" }),
  ).toBeDisabled()
  await expect(
    page.getByRole("menuitem", { name: "本次学习进行中，无法删除" }),
  ).toBeDisabled()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "继续学习" }).first().click()
  await expect(page).toHaveURL(/\/app\/session\//)
  expect(page.url()).toBe(firstSessionUrl)
  await expect(page.getByRole("checkbox").first()).toBeChecked()
  await expect(page.getByRole("checkbox").nth(1)).not.toBeChecked()

  await page.getByRole("button", { name: "继续" }).click()
  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await page.getByRole("button", { name: "结束本次学习" }).click()
  await expect(
    page.getByRole("heading", { name: "结束这一段学习？" }),
  ).toBeVisible()
  await page
    .getByRole("button", { name: /^结束并返回(?:任务台|学习计划)$/ })
    .click()
  await expect(page).toHaveURL(/\/app$/)

  await expect(page.getByText("完成一轮物理总复习")).toBeVisible()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  expect(page.url()).not.toBe(firstSessionUrl)
  await page.getByRole("checkbox").nth(1).click()
  await page.getByRole("button", { name: /^确认完成(?:计划)?$/ }).click()
  await page.getByRole("button", { name: "完成并立即复盘" }).click()
  await page.getByRole("link", { name: "跳过复盘并返回" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await page.getByRole("button", { name: "已完成 1" }).click()
  await expect(page.getByText("完成一轮物理总复习")).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
})

test("全步骤完成后等待确认，且支持复制或重新打开", async ({ page }) => {
  await page.goto("/app")
  await createManualPlan(page, "完成一次待确认任务", ["完成唯一步骤"])

  const taskHeading = page.getByRole("heading", {
    name: "完成一次待确认任务",
  })
  const compactRow = taskHeading.locator(
    "xpath=ancestor::*[@data-slot='card'][1]",
  )
  const box = await compactRow.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(box!.height * 3)

  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  await page.getByRole("checkbox", { name: "完成唯一步骤" }).click()
  await page.getByRole("button", { name: "结束本次学习", exact: true }).click()
  await expect(
    page.getByText("步骤已完成，返回后请对照完成标准确认完成计划。", {
      exact: false,
    }),
  ).toBeVisible()
  await expect(page.getByText(/下次开始会创建一段新的学习记录/)).toHaveCount(0)
  await page.getByRole("button", { name: "继续保留暂停状态" }).click()
  await page.getByRole("button", { name: /^返回(?:任务台|学习计划)$/ }).click()
  await expect(page).toHaveURL(/\/app$/)

  await expect(
    compactRow
      .getByText("待确认完成", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
  await page.getByRole("button", { name: /^确认完成(?:计划)?$/ }).click()
  const completionDialog = page.getByRole("alertdialog", {
    name: "确认完成这个学习计划？",
  })
  await completionDialog
    .getByRole("button", { name: /^确认完成(?:计划)?$/ })
    .click()
  await expect(page.getByRole("button", { name: "已完成 1" })).toBeVisible()

  await page.getByRole("button", { name: "已完成 1" }).click()
  await page.getByRole("button", { name: /^(?:任务|学习计划)操作$/ }).click()
  await page
    .getByRole("menuitem", { name: /^复制为新(?:任务|学习计划)$/ })
    .click()
  await expect(
    page.getByRole("heading", { name: "完成一次待确认任务（副本）" }),
  ).toBeVisible()

  await page.getByRole("button", { name: "已完成 1" }).click()
  await page.getByRole("button", { name: /^(?:任务|学习计划)操作$/ }).click()
  await page
    .getByRole("menuitem", { name: /^重新打开(?:任务|学习计划)$/ })
    .click()
  const reopenDialog = page.getByRole("alertdialog", {
    name: "重新打开“完成一次待确认任务”？",
  })
  await reopenDialog.getByRole("button", { name: "重新打开" }).click()
  await page.getByRole("button", { name: "待完成 2" }).click()
  const reopenedRow = page
    .getByRole("heading", { name: "完成一次待确认任务", exact: true })
    .locator("xpath=ancestor::*[@data-slot='card'][1]")
  await expect(
    reopenedRow.getByText("待继续", { exact: true }).filter({ visible: true }),
  ).toBeVisible()
  await expect(
    reopenedRow.getByText("0/1 步", { exact: true }).last(),
  ).toBeVisible()
})

test("任务可归档、在已归档列表恢复并重新开始", async ({ page }) => {
  await page.goto("/app")
  await createManualPlan(page, "整理暂停推进的实验记录", ["整理现有数据"])

  await expect(
    page.getByRole("heading", { name: "整理暂停推进的实验记录" }),
  ).toBeVisible()
  await page.getByRole("button", { name: /^(?:任务|学习计划)操作$/ }).click()
  await page.getByRole("menuitem", { name: /^归档(?:任务|学习计划)$/ }).click()

  await expect(page.getByText("学习计划已归档", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "当前没有待完成学习计划" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "已归档 1" })).toBeVisible()
  await page.getByRole("button", { name: "查看已归档" }).click()

  await expect(
    page.getByRole("heading", { name: "整理暂停推进的实验记录" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
  await page.getByRole("button", { name: /^(?:任务|学习计划)操作$/ }).click()
  await page
    .getByRole("menuitem", { name: /^恢复到(?:任务台|学习计划)$/ })
    .click()

  await expect(
    page.getByRole("heading", { name: "还没有归档学习计划" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "待完成 1" }).click()
  await expect(
    page.getByRole("heading", { name: "整理暂停推进的实验记录" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toBeVisible()
})

test("从全局导航离开会自动暂停，并锁定当前会话的观察方式", async ({ page }) => {
  await page.goto("/app")
  await createManualPlan(page, "阅读一章科创方法", ["读完本章并做批注"])
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  const sessionUrl = page.url()
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible()

  await page.getByRole("link", { name: "学迹学习计划首页" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText("状态：已暂停")).toBeVisible()

  await page.getByRole("button", { name: /^(?:任务|学习计划)操作$/ }).click()
  await page.getByRole("menuitem", { name: /^编辑(?:任务|学习计划)$/ }).click()
  await expect(page).toHaveURL(/\/app\/plans\/new\?task=/)
  await expect(page.getByLabel("学习计划名称")).toBeDisabled()
  await expect(page.getByText(/请先结束本次学习，再修改结构/)).toBeVisible()
  await page.getByRole("link", { name: "学迹学习计划首页" }).click()

  await page.getByRole("button", { name: "继续学习" }).first().click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  expect(page.url()).toBe(sessionUrl)
})

test("显式导航会作废尚未提交的待决恢复", async ({ page }) => {
  await page.goto("/app")
  await createManualPlan(page, "验证导航状态屏障", ["发出恢复后立即离开"])
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()

  const pendingResume = page.waitForResponse((response) =>
    response.url().endsWith("/rest/v1/rpc/resume_study_session"),
  )
  await page.getByRole("button", { name: "继续" }).click()
  await page.getByRole("link", { name: "学迹学习计划首页" }).click()
  await pendingResume

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText("状态：已暂停")).toBeVisible()
})

test("浏览器后退会在待决恢复提交后再次暂停", async ({ page }) => {
  await page.goto("/app")
  await createManualPlan(page, "验证后退暂停兜底", ["恢复尚未提交时返回任务台"])
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  await page.getByRole("button", { name: "暂停", exact: true }).click()

  const pendingResume = page.waitForResponse((response) =>
    response.url().endsWith("/rest/v1/rpc/resume_study_session"),
  )
  await page.getByRole("button", { name: "继续" }).click()
  await page.goBack()
  await pendingResume

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText("状态：已暂停")).toBeVisible()
})

test("AI 生成可编辑的三步初稿并为离开设备运动关闭摄像头", async ({ page }) => {
  const plan = {
    ...manualLearningPlan("去操场慢跑", 30),
    steps: ["准备运动装备并热身", "完成 20 分钟慢跑", "拉伸并记录感受"].map(
      (title) => ({ id: crypto.randomUUID(), title, completed: false }),
    ),
    observationProfile: "off_device_v1",
    observationAgreement: {
      phone: "ignored",
      tablet: "ignored",
      absenceSeconds: null,
      screenDirection: false,
    },
  }
  await page.route("**/api/planning/prepare", (route) =>
    route.fulfill({ json: { kind: "plan", plan } }),
  )
  await page.route("**/api/planning/review", (route) =>
    route.fulfill({
      json: {
        comment: "增加慢跑时长，可以按体感自行调整。",
        reason: "这是对执行时长的修改。",
        suggestion: null,
      },
    }),
  )

  await page.goto("/app")
  await page
    .getByRole("button", { name: "制定计划", exact: true })
    .first()
    .click()
  await page.getByLabel("学习意图", { exact: true }).fill("去操场慢跑")
  await page.getByRole("button", { name: "生成推荐方案" }).click()
  await expect(page.getByLabel("执行步骤 2", { exact: true })).toHaveValue(
    "完成 20 分钟慢跑",
  )
  await page.getByLabel("执行步骤 2", { exact: true }).fill("完成 25 分钟慢跑")
  await page.getByRole("button", { name: "确认方案" }).click()
  await page.getByRole("button", { name: "保留我的方案" }).click()
  await expect(page.getByLabel("学习方式")).toHaveValue("off_device_v1")
  await page.getByRole("button", { name: "保存学习计划" }).click()
  await expect(page.getByRole("heading", { name: "去操场慢跑" })).toBeVisible()

  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//, { timeout: 20_000 })
  await expect(
    page.getByText(/此(?:任务|学习计划)不使用电脑摄像头/),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "开启本地观察" })).toHaveCount(
    0,
  )
})
