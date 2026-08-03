import type { Metadata } from "next"

import { SessionScreen } from "@/components/session/session-screen"

export const metadata: Metadata = {
  title: "学习会话",
  description: "计时、可选本地视觉观察与低打扰提醒。",
}

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <SessionScreen sessionId={id} />
}
