import type { Metadata } from "next"

import { InsightsScreen } from "@/components/insights/insights-screen"

export const metadata: Metadata = {
  title: "学习报告",
  description: "从真实学习记录、采用方案和复盘中，查看事实依据与可选 AI 解读。",
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const query = await searchParams
  return <InsightsScreen initialDays={query.period === "7" ? 7 : 30} />
}
