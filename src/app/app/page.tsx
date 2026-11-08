import type { Metadata } from "next"

import { TaskDashboard } from "@/components/tasks/task-dashboard"

export const metadata: Metadata = {
  title: "学习计划",
  description: "制定计划、推进执行步骤，并记录每次学习与复盘。",
}

export default function StudyAppPage() {
  return <TaskDashboard />
}
