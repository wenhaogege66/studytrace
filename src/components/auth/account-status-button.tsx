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
    <Button variant="ghost" className="h-auto min-h-11 py-1.5" asChild>
      <Link
        href="/auth"
        onNavigate={onNavigate}
        aria-label={
          permanent
            ? `账号 ${maskEmail(user?.email ?? "")} 已同步；前往管理或退出`
            : "临时记录，仅此浏览器；前往保存并同步"
        }
      >
        {permanent ? <Cloud /> : <HardDrive />}
        <span className="flex max-w-40 flex-col items-start leading-tight">
          <span className="w-full truncate text-xs text-slate-700">
            {permanent ? maskEmail(user?.email ?? "") : "临时记录 · 仅此浏览器"}
          </span>
          <span
            className={
              permanent
                ? "text-[11px] font-medium text-emerald-700"
                : "text-[11px] font-semibold text-indigo-700"
            }
          >
            {permanent ? "已同步 · 管理账号" : "保存并同步"}
          </span>
        </span>
      </Link>
    </Button>
  )
}
