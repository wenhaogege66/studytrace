import type { Metadata } from "next"

import { ReviewScreen } from "@/components/review/review-screen"

export const metadata: Metadata = {
  title: "单次复盘",
  description: "对照预计与实际时长，修正事件并写下下一次调整。",
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <ReviewScreen sessionId={id} />
}
