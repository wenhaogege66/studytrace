import type { Metadata } from "next"

import { SettingsScreen } from "@/components/settings/settings-screen"

export const metadata: Metadata = {
  title: "数据与设置",
  description: "查看数据用途、调整提醒与视觉阈值，并清除匿名学习记录。",
}

export default function SettingsPage() {
  return <SettingsScreen />
}
