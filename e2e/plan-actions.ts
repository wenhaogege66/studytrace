import { expect, type Page } from "@playwright/test"

export async function createManualPlan(
  page: Page,
  title: string,
  steps: string[],
  minutes = 25,
  profile = "study_screen_v1",
  phonePolicy?: "allowed" | "restricted" | "ignored",
) {
  await page
    .getByRole("button", { name: "制定计划", exact: true })
    .first()
    .click()
  await expect(page).toHaveURL(/\/app\/plans\/new/)
  await page.getByLabel("学习意图", { exact: true }).fill(title)
  await page.getByRole("button", { name: "手动制定", exact: true }).click()
  await page.getByLabel("学习计划名称").fill(title)
  while (
    (await page.getByRole("button", { name: /^删除步骤 / }).count()) >
    steps.length
  )
    await page
      .getByRole("button", { name: /^删除步骤 / })
      .last()
      .click()
  while (
    (await page.getByRole("button", { name: /^删除步骤 / }).count()) <
    steps.length
  )
    await page.getByRole("button", { name: "添加执行步骤" }).click()
  for (let index = 0; index < steps.length; index++)
    await page
      .getByLabel(`执行步骤 ${index + 1}`, { exact: true })
      .fill(steps[index])
  await page.getByLabel("整个计划预计（分钟）").fill(String(minutes))
  await page.getByRole("button", { name: "确认方案" }).click()
  await page.getByLabel("学习方式", { exact: true }).selectOption(profile)
  if (phonePolicy)
    await page.getByLabel("手机", { exact: true }).selectOption(phonePolicy)
  await page.getByRole("button", { name: "保存学习计划" }).click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible()
}
