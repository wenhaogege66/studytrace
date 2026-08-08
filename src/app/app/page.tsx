import type { Metadata } from "next"

import { TaskDashboard } from "@/components/tasks/task-dashboard"

export const metadata: Metadata = {
  title: "学习任务",
  description: "创建、拆分、排序并开始一段可复盘的学习任务。",
}

export default function StudyAppPage() {
  return <TaskDashboard />
}
