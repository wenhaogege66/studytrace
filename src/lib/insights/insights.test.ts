import { describe, expect, it } from "vitest"

import {
  buildInsightSuggestion,
  formatEvidenceDuration,
  parseInsightsReport,
  type InsightsReport,
} from "./insights"

function report(overrides: Partial<InsightsReport> = {}): InsightsReport {
  return {
    enabled: true,
    generated_at: "2026-09-07T08:00:00Z",
    period: {
      days: 30,
      timezone: "Asia/Shanghai",
      start_at: "2026-08-09T16:00:00Z",
      end_at: "2026-09-08T16:00:00Z",
    },
    overview: {
      active_days: 4,
      completed_tasks: 2,
      actual_seconds: 7200,
      reviewed_sessions: 2,
      terminal_sessions: 3,
      review_coverage_percent: 66.7,
    },
    segments: {
      eligible_count: 8,
      median_seconds: 1800,
      backfilled_count: 0,
      distribution: [
        { id: "under_15", label: "2–15 分钟", count: 2 },
        { id: "15_30", label: "15–30 分钟", count: 6 },
      ],
    },
    time_buckets: [],
    observation: {
      observed_seconds: 3600,
      coverage_percent: 50,
      confirmed_event_count: 2,
      confirmed_events_per_hour: 2,
      reminder_responses: {
        none: 0,
        dismissed: 0,
        back_to_task: 1,
        normal_activity: 1,
        not_needed: 0,
        later: 0,
      },
    },
    precursor: {
      evidence_window_days: 30,
      manual_marker_count: 3,
      correlated_marker_count: 1,
      correlated_percent: 33.3,
    },
    readiness: {
      evidence_window_days: 30,
      evidence_eligible_segments: 8,
      evidence_active_days: 4,
      evidence_median_seconds: 1800,
      patterns_ready: false,
      required_segments: 20,
      required_active_days: 10,
      precursor_ready: false,
      required_manual_markers: 10,
    },
    ...overrides,
  }
}

describe("fact-based insights", () => {
  it("parses numeric Postgres JSON values without exposing raw records", () => {
    const parsed = parseInsightsReport({
      ...report(),
      overview: { ...report().overview, actual_seconds: "7200" },
    })
    expect(parsed.overview.actual_seconds).toBe(7200)
    expect(parsed).not.toHaveProperty("user_id")
  })

  it("shows collection progress until both sample thresholds are met", () => {
    const suggestion = buildInsightSuggestion(report())
    expect(suggestion.ready).toBe(false)
    expect(suggestion.progressPercent).toBe(40)
    expect(suggestion.detail).toContain("12 个有效投入片段")
    expect(suggestion.detail).toContain("6 个活跃日")
    expect(suggestion.detail).toContain("近 30 天")
    expect(suggestion.focusMinutes).toBeNull()
  })

  it("turns a supported median into a bounded experiment suggestion", () => {
    const input = report({
      overview: { ...report().overview, active_days: 12 },
      segments: {
        ...report().segments,
        eligible_count: 25,
        median_seconds: 2700,
      },
      readiness: {
        ...report().readiness,
        evidence_eligible_segments: 25,
        evidence_active_days: 12,
        evidence_median_seconds: 2700,
        patterns_ready: true,
      },
      time_buckets: [
        {
          id: "morning",
          label: "早晨 05–11",
          segment_count: 8,
          actual_seconds: 14400,
          reviewed_count: 4,
          average_rating: 4.5,
          outcome_count: 4,
          completion_percent: 75,
        },
        {
          id: "evening",
          label: "晚间 18–24",
          segment_count: 9,
          actual_seconds: 18000,
          reviewed_count: 5,
          average_rating: 3.8,
          outcome_count: 5,
          completion_percent: 80,
        },
      ],
    })

    const suggestion = buildInsightSuggestion(input)
    expect(suggestion.title).toBe("下一阶段可尝试 45 + 8 分钟")
    expect(suggestion.bestTimeBucket?.id).toBe("morning")
    expect(suggestion.detail).toContain("实验建议")
  })

  it("describes precursors as user-confirmed co-occurrence, not causality", () => {
    const suggestion = buildInsightSuggestion(
      report({
        precursor: {
          ...report().precursor,
          manual_marker_count: 10,
          correlated_marker_count: 6,
          correlated_percent: 60,
        },
        readiness: { ...report().readiness, precursor_ready: true },
      }),
    )
    expect(suggestion.precursorStatement).toContain("此前 5 分钟")
    expect(suggestion.precursorStatement).toContain("共现记录")
    expect(suggestion.precursorStatement).not.toContain("走神")
  })

  it("keeps empty ratings nullable instead of coercing them to zero", () => {
    const parsed = parseInsightsReport({
      ...report(),
      time_buckets: [
        {
          id: "morning",
          label: "早晨 05–11",
          segment_count: 0,
          actual_seconds: 0,
          reviewed_count: 0,
          average_rating: null,
          outcome_count: 0,
          completion_percent: null,
        },
      ],
    })

    expect(parsed.time_buckets[0]?.average_rating).toBeNull()
    expect(parsed.time_buckets[0]?.completion_percent).toBeNull()
  })

  it("uses the 30-day evidence median even for a shorter display window", () => {
    const suggestion = buildInsightSuggestion(
      report({
        period: { ...report().period, days: 7 },
        segments: {
          ...report().segments,
          eligible_count: 2,
          median_seconds: 600,
        },
        readiness: {
          ...report().readiness,
          evidence_eligible_segments: 25,
          evidence_active_days: 12,
          evidence_median_seconds: 2700,
          patterns_ready: true,
        },
      }),
    )

    expect(suggestion.ready).toBe(true)
    expect(suggestion.focusMinutes).toBe(45)
  })

  it("formats short and long durations for scanning", () => {
    expect(formatEvidenceDuration(30)).toBe("不足 1 分钟")
    expect(formatEvidenceDuration(1800)).toBe("30 分钟")
    expect(formatEvidenceDuration(7500)).toBe("2 小时 5 分钟")
    expect(formatEvidenceDuration(3599)).toBe("59 分钟")
  })
})
