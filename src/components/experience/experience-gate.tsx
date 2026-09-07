"use client"

import { Turnstile } from "@marsidev/react-turnstile"
import {
  ArrowRight,
  Database,
  EyeOff,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from "lucide-react"
import Link from "next/link"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"

import { AppShell } from "@/components/app-shell"
import { useExperience } from "@/components/experience/experience-provider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

export function ExperienceGate({ children }: { children: ReactNode }) {
  const { begin, error, retry, status } = useExperience()
  const [understood, setUnderstood] = useState(false)
  const [showChallenge, setShowChallenge] = useState(false)

  if (status === "ready") return <AppShell>{children}</AppShell>

  if (status === "checking") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center px-5 py-12">
        <Card className="w-full border-indigo-100 bg-white/80 shadow-xl shadow-indigo-950/5">
          <CardHeader>
            <Skeleton className="h-8 w-44" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </CardContent>
        </Card>
      </main>
    )
  }

  if (status === "error") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-5 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>体验环境暂不可用</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={retry}>
              <RotateCcw /> 重试
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  const enter = async (token?: string) => {
    try {
      await begin(token)
      toast.success("匿名体验已准备好")
    } catch {
      toast.error("暂时无法开始，请稍后重试")
      setShowChallenge(false)
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-5 py-12 sm:py-20">
      <div className="page-orb page-orb-left" />
      <div className="page-orb page-orb-right" />
      <div className="relative mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1fr_0.9fr] lg:items-center">
        <section>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white/70 px-3 py-1.5 text-sm text-indigo-800">
            <ShieldCheck className="size-4" /> 无账号体验 · 数据按匿名会话隔离
          </div>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance text-slate-950 sm:text-5xl">
            先把要做的事说清楚，再开始一段可复盘的学习。
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-pretty text-slate-600 sm:text-lg">
            学迹把任务、计时、本地视觉观察与一次复盘连成闭环。它只记录可由你修正的行为事件，不上传摄像头画面，也不给你打“专注分”。
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              [Database, "匿名保存", "清除浏览器数据后不可恢复"],
              [EyeOff, "本地识别", "画面与人脸关键点不上传"],
              [ShieldCheck, "你可修正", "确认、改写或硬删除事件"],
            ].map(([Icon, title, description]) => (
              <div
                key={String(title)}
                className="rounded-2xl border border-white/80 bg-white/65 p-4 shadow-sm backdrop-blur"
              >
                <Icon className="mb-3 size-5 text-indigo-700" />
                <p className="font-medium text-slate-900">{title as string}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {description as string}
                </p>
              </div>
            ))}
          </div>
        </section>

        <Card className="border-white/90 bg-white/90 shadow-2xl shadow-indigo-950/10 backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="text-2xl">开始体验</CardTitle>
            <CardDescription>
              无需先注册；可以直接匿名体验，已有邮箱记录也可恢复。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Alert className="border-amber-200 bg-amber-50/70 text-amber-950">
              <Database />
              <AlertTitle>匿名数据提示</AlertTitle>
              <AlertDescription>
                换设备、清除本站浏览器数据或主动清除全部记录后，历史无法恢复；匿名身份连续
                30 天无活动后才会被定时清理。
              </AlertDescription>
            </Alert>

            <div className="flex items-start gap-3 rounded-xl border bg-slate-50/80 p-4">
              <Checkbox
                id="anonymous-data-notice"
                checked={understood}
                onCheckedChange={(checked) => setUnderstood(checked === true)}
              />
              <Label
                htmlFor="anonymous-data-notice"
                className="cursor-pointer leading-5 text-slate-700"
              >
                我理解匿名数据不可跨设备恢复，并同意仅保存结构化学习记录。
              </Label>
            </div>

            {showChallenge && turnstileSiteKey ? (
              <div className="rounded-xl border bg-white p-3">
                <p className="mb-3 text-sm text-slate-600">
                  完成一次安全校验后即进入产品。
                </p>
                <Turnstile
                  siteKey={turnstileSiteKey}
                  onSuccess={(token) => void enter(token)}
                />
              </div>
            ) : null}

            <Button
              size="lg"
              className="h-11 w-full"
              disabled={!understood || status === "starting"}
              onClick={() => {
                if (turnstileSiteKey) setShowChallenge(true)
                else void enter()
              }}
            >
              {status === "starting" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowRight />
              )}
              {status === "starting"
                ? "正在准备匿名会话"
                : showChallenge
                  ? "等待安全校验"
                  : "开始体验"}
            </Button>
            <div className="border-t border-slate-200 pt-4 text-center">
              <Button variant="ghost" className="min-h-11" asChild>
                <Link href="/auth">已有邮箱记录？验证并恢复</Link>
              </Button>
            </div>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
