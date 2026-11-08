import type { Metadata } from "next"

import { SessionScreen } from "@/components/session/session-screen"

export const metadata: Metadata = {
  title: "本次学习",
  description: "按采用方案推进、计时、可选过程观察与低打扰提醒。",
}

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <SessionScreen key={id} sessionId={id} />
}
