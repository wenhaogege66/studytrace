import { expect, test } from "@playwright/test"

import { installMockSupabase } from "./mock-supabase"

test("长期洞察对空样本说明收集门槛", async ({ page }) => {
  await installMockSupabase(page)
  await page.goto("/app/insights")

  await expect(
    page.getByRole("heading", { name: "你实际是怎么投入时间的" }),
  ).toBeVisible()
  await expect(page.getByText("当前窗口还没有有效投入片段")).toBeVisible()
  await expect(page.getByText("先继续记录，不急着下结论")).toBeVisible()
  await expect(page.getByText(/近 30 天的证据池/)).toBeVisible()
})

test("长期洞察在样本不足时展示事实与收集缺口", async ({ page }) => {
  await installMockSupabase(page, {
    insightsReport: {
      enabled: true,
      generated_at: "2026-09-08T08:00:00.000Z",
      overview: {
        active_days: 3,
        completed_tasks: 1,
        actual_seconds: 3600,
        reviewed_sessions: 2,
        terminal_sessions: 3,
        review_coverage_percent: 66.7,
      },
      segments: {
        eligible_count: 6,
        median_seconds: 600,
        backfilled_count: 0,
        distribution: [{ id: "under_15", label: "2–15 分钟", count: 6 }],
      },
      time_buckets: [
        {
          id: "morning",
          label: "早晨 05–11",
          segment_count: 6,
          actual_seconds: 3600,
          reviewed_count: 2,
          average_rating: 4,
          outcome_count: 3,
          completion_percent: 33.3,
        },
      ],
      observation: {
        observed_seconds: 600,
        coverage_percent: 16.7,
        confirmed_event_count: 1,
        confirmed_events_per_hour: 6,
        reminder_responses: {
          none: 0,
          dismissed: 0,
          back_to_task: 1,
          normal_activity: 0,
          not_needed: 0,
          later: 0,
        },
      },
      precursor: {
        evidence_window_days: 30,
        manual_marker_count: 2,
        correlated_marker_count: 1,
        correlated_percent: 50,
      },
      readiness: {
        evidence_window_days: 30,
        evidence_eligible_segments: 6,
        evidence_active_days: 3,
        evidence_median_seconds: 600,
        patterns_ready: false,
        required_segments: 20,
        required_active_days: 10,
        precursor_ready: false,
        required_manual_markers: 10,
      },
    },
  })
  await page.goto("/app/insights")

  const summary = page.getByLabel("本期摘要")
  await expect(summary.getByText("1 小时")).toBeVisible()
  await expect(summary.getByText("6 个有效片段")).toBeVisible()
  await expect(page.getByText("先继续记录，不急着下结论")).toBeVisible()
  await expect(page.getByText(/14 个有效投入片段、7 个活跃日/)).toBeVisible()
  await expect(page.getByText("形成建议所需样本")).toBeVisible()
  await expect(
    page.getByRole("heading", { name: /下一阶段可尝试/ }),
  ).toHaveCount(0)
})

test("长期洞察展示可追溯的完成、观察与提醒事实", async ({ page }) => {
  await installMockSupabase(page, {
    insightsReport: {
      enabled: true,
      generated_at: "2026-09-08T08:00:00.000Z",
      overview: {
        active_days: 12,
        completed_tasks: 4,
        actual_seconds: 32400,
        reviewed_sessions: 8,
        terminal_sessions: 10,
        review_coverage_percent: 80,
      },
      segments: {
        eligible_count: 24,
        median_seconds: 2400,
        backfilled_count: 0,
        distribution: [{ id: "30_45", label: "30–45 分钟", count: 24 }],
      },
      time_buckets: [
        {
          id: "morning",
          label: "早晨 05–11",
          segment_count: 12,
          actual_seconds: 18000,
          reviewed_count: 4,
          average_rating: 4.5,
          outcome_count: 4,
          completion_percent: 75,
        },
      ],
      observation: {
        observed_seconds: 3600,
        coverage_percent: 11.1,
        confirmed_event_count: 2,
        confirmed_events_per_hour: 2,
        reminder_responses: {
          none: 1,
          dismissed: 0,
          back_to_task: 2,
          normal_activity: 1,
          not_needed: 0,
          later: 1,
        },
      },
      precursor: {
        evidence_window_days: 30,
        manual_marker_count: 10,
        correlated_marker_count: 4,
        correlated_percent: 40,
      },
      readiness: {
        evidence_window_days: 30,
        evidence_eligible_segments: 24,
        evidence_active_days: 12,
        evidence_median_seconds: 2400,
        patterns_ready: true,
        required_segments: 20,
        required_active_days: 10,
        precursor_ready: true,
        required_manual_markers: 10,
      },
    },
  })
  await page.goto("/app/insights")

  await expect(page.getByText("完成 75% · 4 次结束会话")).toBeVisible()
  await expect(page.getByText("2/小时")).toBeVisible()
  await expect(page.getByText("确认事件率")).toBeVisible()
  await expect(page.getByText("轻提醒后的反馈")).toBeVisible()
  await expect(page.getByText(/10 次主动标记中/)).toBeVisible()

  await page.getByRole("button", { name: "近 7 天" }).click()
  await expect(page.getByText("当前 7 天窗口")).toBeVisible()
})
