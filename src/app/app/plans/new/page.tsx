import type { Metadata } from "next"

import { PlanningScreen } from "@/components/planning/planning-screen"

export const metadata: Metadata = {
  title: "制定学习计划",
  description: "澄清学习意图，选择推荐方案并确认过程观察约定。",
}

export default async function NewLearningPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ task?: string }>
}) {
  const { task } = await searchParams
  return <PlanningScreen taskId={task} />
}
