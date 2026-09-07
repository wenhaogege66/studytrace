import type { Metadata } from "next"

import { AuthScreen } from "@/components/auth/auth-screen"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "账号与同步",
  description: "用邮箱验证码保存、恢复或删除学迹记录。",
  robots: { index: false, follow: false },
}

export default function AuthPage() {
  return <AuthScreen />
}
