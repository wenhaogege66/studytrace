import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

test.beforeEach(async ({ page }, testInfo) => {
  await installMockSupabase(page, {
    resumeDelayMs: testInfo.title.includes("待决恢复") ? 1_000 : undefined,
  })
})

test("任务、学习会话、摄像头拒绝与复盘构成完整降级闭环", async ({ page }) => {
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

  const emptyTaskCard = page
    .getByRole("heading", { name: "任务台还是空的" })
    .locator("..")
  await emptyTaskCard.getByRole("button", { name: "新建任务" }).click()
  await page.getByLabel("任务标题").fill("完成一次科创问题定义")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("写下可验证的问题")
  await page.getByLabel("预计时长（分钟）").fill("20")
  await page.getByRole("button", { name: "创建任务" }).click()

  await expect(page.getByText("完成一次科创问题定义")).toBeVisible()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
  await expect(
    page.getByRole("heading", { name: "完成一次科创问题定义" }),
  ).toBeVisible()

  await page.getByRole("button", { name: "开启本地观察" }).click()
  await expect(
    page.getByText("你拒绝了摄像头授权。学习计时和手动复盘不会受影响。"),
  ).toBeVisible()

  await page.getByRole("button", { name: "手动标记" }).click()
  await expect(page.getByText("已添加一条手动标记")).toBeVisible()

  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()
  await page.getByRole("button", { name: "继续" }).click()

  await expect(page.getByRole("button", { name: "结束并复盘" })).toHaveCount(0)
  await page.getByRole("checkbox").click()
  await page.getByRole("button", { name: "结束并复盘" }).click()
  await expect(
    page.getByRole("heading", {
      name: "确认完成这个任务？",
    }),
  ).toBeVisible()
  await page.getByRole("button", { name: "确认结束并复盘" }).click()
  await expect(page).toHaveURL(/\/app\/review\//)
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

  await page.getByRole("link", { name: "回到任务台" }).click()
  await page.getByRole("button", { name: "已完成 1" }).click()
  await expect(page.getByText("完成一次科创问题定义")).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
})

test("大任务暂停后恢复同一会话，并在完成全部步骤后结束", async ({ page }) => {
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("完成一轮物理总复习")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("复习力学")
  await page
    .getByRole("textbox", { name: "步骤 2", exact: true })
    .fill("复习电磁学")
  await page.getByRole("button", { name: "创建任务" }).click()

  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
  const firstSessionUrl = page.url()
  await page.getByRole("checkbox").first().click()
  await expect(page.getByText("1/2")).toBeVisible()
  await expect(page.getByRole("button", { name: "结束并复盘" })).toHaveCount(0)

  await page.getByRole("button", { name: "暂停并返回" }).click()
  await expect(page).toHaveURL(/\/app$/)

  await expect(page.getByText("完成一轮物理总复习")).toBeVisible()
  await expect(page.getByText("1/2 步")).toBeVisible()
  await page.getByRole("button", { name: "任务操作" }).click()
  await expect(
    page.getByRole("menuitem", { name: "学习会话进行中，无法归档" }),
  ).toBeDisabled()
  await expect(
    page.getByRole("menuitem", { name: "学习会话进行中，无法删除" }),
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
  await page.getByRole("button", { name: "结束并返回任务台" }).click()
  await expect(page).toHaveURL(/\/app$/)

  await expect(page.getByText("完成一轮物理总复习")).toBeVisible()
  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page).toHaveURL(/\/app\/session\//)
  expect(page.url()).not.toBe(firstSessionUrl)
  await page.getByRole("checkbox").nth(1).click()
  await page.getByRole("button", { name: "结束并复盘" }).click()
  await page.getByRole("button", { name: "确认结束并复盘" }).click()
  await page.getByRole("link", { name: "跳过复盘并返回" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await page.getByRole("button", { name: "已完成 1" }).click()
  await expect(page.getByText("完成一轮物理总复习")).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
})

test("任务可归档、在已归档列表恢复并重新开始", async ({ page }) => {
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("整理暂停推进的实验记录")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("整理现有数据")
  await page.getByRole("button", { name: "创建任务" }).click()

  await expect(
    page.getByRole("heading", { name: "整理暂停推进的实验记录" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "任务操作" }).click()
  await page.getByRole("menuitem", { name: "归档任务" }).click()

  await expect(page.getByText("任务已归档", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "当前没有待完成任务" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "已归档 1" })).toBeVisible()
  await page.getByRole("button", { name: "查看已归档" }).click()

  await expect(
    page.getByRole("heading", { name: "整理暂停推进的实验记录" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toHaveCount(0)
  await page.getByRole("button", { name: "任务操作" }).click()
  await page.getByRole("menuitem", { name: "恢复到任务台" }).click()

  await expect(
    page.getByText("任务已恢复到任务台", { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "还没有归档任务" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "待完成 1" }).click()
  await expect(
    page.getByRole("heading", { name: "整理暂停推进的实验记录" }),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "开始学习" })).toBeVisible()
})

test("从全局导航离开会自动暂停，并锁定当前会话的观察方式", async ({ page }) => {
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("阅读一章科创方法")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("读完本章并做批注")
  await page.getByRole("button", { name: "创建任务" }).click()
  await page.getByRole("button", { name: "开始学习" }).click()
  const sessionUrl = page.url()
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible()

  await page.getByRole("link", { name: "学迹任务首页" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText("状态：已暂停")).toBeVisible()

  await page.getByRole("button", { name: "任务操作" }).click()
  await page.getByRole("menuitem", { name: "编辑任务" }).click()
  await expect(page.getByLabel("任务观察方式")).toBeDisabled()
  await expect(page.getByText(/结束本次学习后可修改/)).toBeVisible()
  await page.getByRole("button", { name: "取消" }).click()

  await page.getByRole("button", { name: "继续学习" }).first().click()
  expect(page.url()).toBe(sessionUrl)
})

test("显式导航会作废尚未提交的待决恢复", async ({ page }) => {
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("验证导航状态屏障")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("发出恢复后立即离开")
  await page.getByRole("button", { name: "创建任务" }).click()
  await page.getByRole("button", { name: "开始学习" }).click()
  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible()

  const pendingResume = page.waitForResponse((response) =>
    response.url().endsWith("/rest/v1/rpc/resume_study_session"),
  )
  await page.getByRole("button", { name: "继续" }).click()
  await page.getByRole("link", { name: "学迹任务首页" }).click()
  await pendingResume

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByText("状态：已暂停")).toBeVisible()
})

test("浏览器后退会在待决恢复提交后再次暂停", async ({ page }) => {
  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("验证后退暂停兜底")
  await page
    .getByRole("textbox", { name: "步骤 1", exact: true })
    .fill("恢复尚未提交时返回任务台")
  await page.getByRole("button", { name: "创建任务" }).click()
  await page.getByRole("button", { name: "开始学习" }).click()
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
  await page.route("**/api/tasks/suggest-plan", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        steps: ["准备运动装备并热身", "完成 20 分钟慢跑", "拉伸并记录感受"],
        priority: "medium",
        estimatedMinutes: 30,
        observationProfile: "off_device_v1",
        profileReason: "这项活动会离开电脑完成",
      }),
    })
  })

  await page.goto("/app")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  await page.getByLabel("任务标题").fill("去操场慢跑")
  await page.getByRole("button", { name: "AI 生成 3 步" }).click()

  await expect(page.getByRole("textbox", { name: "步骤 1" })).toHaveValue(
    "准备运动装备并热身",
  )
  await expect(page.getByRole("textbox", { name: "步骤 2" })).toHaveValue(
    "完成 20 分钟慢跑",
  )
  await expect(page.getByRole("textbox", { name: "步骤 3" })).toHaveValue(
    "拉伸并记录感受",
  )
  await expect(page.getByText("这项活动会离开电脑完成")).toBeVisible()

  await page.getByRole("textbox", { name: "步骤 2" }).fill("完成 25 分钟慢跑")
  await page.getByRole("button", { name: "创建任务" }).click()
  await expect(page.getByText("离设备任务")).toBeVisible()

  await page.getByRole("button", { name: "开始学习" }).click()
  await expect(page.getByText("此任务不使用电脑摄像头")).toBeVisible()
  await expect(page.getByRole("button", { name: "开启本地观察" })).toHaveCount(
    0,
  )
})
