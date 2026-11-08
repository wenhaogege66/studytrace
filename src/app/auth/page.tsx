import type { Metadata } from "next"

import { AuthScreen } from "@/components/auth/auth-screen"
import { Providers } from "@/components/providers"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "账号与记录",
  description: "使用独立邮箱密码账号长期保存学习记录，或直接匿名体验。",
  robots: { index: false, follow: false },
}

export default function AuthPage() {
  return (
    <Providers>
      <div className="min-h-screen bg-[var(--app-canvas)] px-4 py-6 sm:px-6 sm:py-10">
        <AuthScreen />
      </div>
    </Providers>
  )
}
