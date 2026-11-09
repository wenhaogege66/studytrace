import { describe, expect, it } from "vitest"

import {
  buildReportEvidence,
  canDiscussPatterns,
  learningReportContentSchema,
  reportSnapshotSchema,
  validateReportCitations,
} from "./contracts"

const rawSnapshot = {
  version: 1,
  facts: {
    enabled: true,
    generated_at: "2026-11-08T08:00:00Z",
    data_coverage: {
      complete: true,
      global_truncated: false,
      period_complete: true,
      recommendation_evidence_complete: true,
      first_truncated_at: null,
      last_truncated_at: null,
      dropped_counts: {},
    },
    period: {
      days: 7,
      timezone: "Asia/Shanghai",
      start_at: "2026-11-01T16:00:00Z",
      end_at: "2026-11-08T16:00:00Z",
    },
    overview: {
      active_days: 3,
      completed_tasks: 2,
      actual_seconds: 4200,
      reviewed_sessions: 2,
      terminal_sessions: 3,
      review_coverage_percent: 66.7,
    },
    segments: {
      eligible_count: 5,
      median_seconds: 900,
      backfilled_count: 0,
      distribution: [],
    },
    time_buckets: [],
    observation: {
      observed_seconds: 600,
      coverage_percent: 14.3,
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
      manual_marker_count: 0,
      correlated_marker_count: 0,
      correlated_percent: 0,
    },
    readiness: {
      evidence_window_days: 30,
      evidence_eligible_segments: 5,
      evidence_active_days: 3,
      evidence_median_seconds: 900,
      patterns_ready: false,
      required_segments: 20,
      required_active_days: 10,
      precursor_ready: false,
      required_manual_markers: 10,
    },
  },
  adopted_plans: [
    {
      purpose: "理解导数",
      criterion: "独立讲解一个例子",
      method: "尝试后检验",
      estimated_minutes: 60,
      status: "in_progress",
      completed_steps: 1,
      step_count: 3,
    },
  ],
  adjustments: [
    {
      kind: "adopted",
      changes: { estimatedMinutes: { before: 60, after: 45 } },
    },
  ],
  estimate_summary: {
    completed_plan_count: 2,
    estimated_minutes: 60,
    actual_seconds: 3000,
  },
  obstacles: [{ reason: "材料不齐", count: 1 }],
}

export function sampleReportSnapshot() {
  return reportSnapshotSchema.parse(structuredClone(rawSnapshot))
}

describe("AI learning report evidence", () => {
  it("builds real evidence with sample sizes and adopted method, without raw media", () => {
    const snapshot = sampleReportSnapshot()
    const evidence = buildReportEvidence(snapshot)
    expect(evidence.find((item) => item.id === "time")).toMatchObject({
      samples: 5,
      value: expect.stringContaining("4200"),
    })
    expect(evidence.find((item) => item.id === "plan_1")?.value).toContain(
      "尝试后检验",
    )
    expect(JSON.stringify(evidence)).not.toMatch(/base64|landmark|data:image/)
  })
  it("rejects references that cannot be traced to current evidence", () => {
    const content = learningReportContentSchema.parse({
      title: "阶段回看",
      summary: "本阶段有投入记录。",
      conclusions: [
        {
          statement: "共投入4200秒",
          evidence: ["time"],
          limitation: "样本不足",
        },
      ],
      encouragement: { text: "你完成了两项计划", evidence: ["completion"] },
      experiments: [
        {
          action: "下次准备好材料",
          reason: "曾记录材料不齐",
          evidence: ["obstacle_1"],
        },
      ],
      limitations: ["记录不代表全部学习"],
    })
    expect(
      validateReportCitations(
        content,
        buildReportEvidence(sampleReportSnapshot()),
      ),
    ).toBe(content)
    content.conclusions[0].evidence = ["fabricated_99"]
    expect(() =>
      validateReportCitations(
        content,
        buildReportEvidence(sampleReportSnapshot()),
      ),
    ).toThrow("REPORT_UNKNOWN_EVIDENCE")
  })
  it("requires complete evidence, twenty valid segments and ten days before discussing patterns", () => {
    const { facts } = sampleReportSnapshot()
    expect(canDiscussPatterns(facts)).toBe(false)
    Object.assign(facts.readiness, {
      patterns_ready: true,
      evidence_eligible_segments: 20,
      evidence_active_days: 10,
    })
    expect(canDiscussPatterns(facts)).toBe(true)
    facts.data_coverage.recommendation_evidence_complete = false
    expect(canDiscussPatterns(facts)).toBe(false)
  })
  it("does not turn missing self ratings into zero evidence", () => {
    const snapshot = sampleReportSnapshot()
    snapshot.facts.time_buckets = [
      {
        id: "morning",
        label: "上午",
        segment_count: 2,
        actual_seconds: 1200,
        reviewed_count: 0,
        average_rating: null,
        outcome_count: 1,
        completion_percent: 0,
      },
    ]
    expect(
      buildReportEvidence(snapshot).find((item) => item.id === "time_morning")
        ?.value,
    ).toContain("暂无")
  })
})
