"use client"

import { Cloud, HardDrive } from "lucide-react"
import Link from "next/link"
import type { ComponentProps } from "react"

import { useExperience } from "@/components/experience/experience-provider"
import { Button } from "@/components/ui/button"
import { maskEmail } from "@/lib/auth/account"

export function AccountStatusButton({
  onNavigate,
}: {
  onNavigate?: ComponentProps<typeof Link>["onNavigate"]
}) {
  const { user } = useExperience()
  const permanent = Boolean(user && !user.is_anonymous && user.email)

  return (
    <Button variant="ghost" className="min-h-11" asChild>
      <Link
        href="/auth"
        onNavigate={onNavigate}
        aria-label={
          permanent
            ? `同步账号 ${maskEmail(user?.email ?? "")}`
            : "临时身份，只能在此浏览器恢复；前往保存并同步"
        }
      >
        {permanent ? <Cloud /> : <HardDrive />}
        <span className="max-w-28 truncate text-xs sm:max-w-36 sm:text-sm">
          {permanent ? maskEmail(user?.email ?? "") : "临时记录"}
        </span>
        {!permanent ? (
          <span className="hidden text-xs text-slate-500 xl:inline">
            · 仅此浏览器
          </span>
        ) : null}
      </Link>
    </Button>
  )
}
