import type { Metadata } from "next"

import { InsightsScreen } from "@/components/insights/insights-screen"

export const metadata: Metadata = {
  title: "长期洞察",
  description: "查看连续投入、时段、复盘与可选视觉观察形成的事实型个人规律。",
}

export default function InsightsPage() {
  return <InsightsScreen />
}
