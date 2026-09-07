"use client"

import {
  BookOpenCheck,
  Code2,
  Home,
  ListTodo,
  Settings,
  Sparkles,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useRef, type ReactNode } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { pauseRunningSessionForNavigation } from "@/lib/data/study-repository"
import { cn } from "@/lib/utils"

const navigation = [
  { href: "/app", label: "任务", icon: ListTodo, exact: true },
  { href: "/app/settings", label: "设置", icon: Settings, exact: false },
]

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const pausingForNavigationRef = useRef(false)
  const guardNavigation = (
    event: { preventDefault: () => void },
    href: string,
  ) => {
    const routeSessionId = window.location.pathname.match(
      /^\/app\/session\/([^/]+)/,
    )?.[1]
    if (!routeSessionId) return
    event.preventDefault()
    if (pausingForNavigationRef.current) return
    pausingForNavigationRef.current = true
    void pauseRunningSessionForNavigation(routeSessionId)
      .then(() => router.push(href))
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error
            ? error.message
            : "暂停失败，已留在当前学习页面",
        ),
      )
      .finally(() => {
        pausingForNavigationRef.current = false
      })
  }

  return (
    <div className="min-h-screen bg-[var(--app-canvas)]">
      <header className="sticky top-0 z-40 border-b border-indigo-100/80 bg-[color:color-mix(in_oklch,var(--app-canvas),white_45%)]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/app"
            onNavigate={(event) => guardNavigation(event, "/app")}
            className="group flex items-center gap-2.5"
            aria-label="学迹任务首页"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-indigo-700 text-white shadow-md shadow-indigo-900/15 transition-transform group-hover:-rotate-3">
              <BookOpenCheck className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-tight text-slate-950">
                学迹 StudyTrace
              </span>
              <span className="block text-[10px] tracking-[0.16em] text-slate-500 uppercase">
                Learn · Observe · Review
              </span>
            </span>
          </Link>

          <nav
            className="hidden items-center gap-1 sm:flex"
            aria-label="应用导航"
          >
            {navigation.map(({ href, label, icon: Icon, exact }) => {
              const active = exact
                ? pathname === href
                : pathname.startsWith(href)
              return (
                <Button
                  key={href}
                  variant={active ? "secondary" : "ghost"}
                  asChild
                >
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    onNavigate={(event) => guardNavigation(event, href)}
                  >
                    <Icon /> {label}
                  </Link>
                </Button>
              )
            })}
            <Separator orientation="vertical" className="mx-2 h-6" />
            <Button variant="ghost" size="icon" asChild>
              <Link
                href="/"
                aria-label="返回产品介绍"
                onNavigate={(event) => guardNavigation(event, "/")}
              >
                <Home />
              </Link>
            </Button>
            <Button variant="ghost" size="icon" asChild>
              <a
                href="https://github.com/wenhaogege66/studytrace"
                target="_blank"
                rel="noreferrer"
                aria-label="查看 GitHub 仓库"
              >
                <Code2 />
              </a>
            </Button>
          </nav>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-4 py-6 pb-24 sm:px-6 sm:py-8 sm:pb-10">
        {children}
      </div>

      <nav
        className="fixed inset-x-4 bottom-4 z-40 grid grid-cols-3 rounded-2xl border border-indigo-100 bg-white/95 p-1.5 shadow-xl shadow-indigo-950/10 backdrop-blur sm:hidden"
        aria-label="移动端导航"
      >
        {navigation.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              onNavigate={(event) => guardNavigation(event, href)}
              className={cn(
                "flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-xs font-medium text-slate-500",
                active && "bg-indigo-50 text-indigo-800",
              )}
            >
              <Icon className="size-4" /> {label}
            </Link>
          )
        })}
        <Link
          href="/"
          onNavigate={(event) => guardNavigation(event, "/")}
          className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-xs font-medium text-slate-500"
        >
          <Sparkles className="size-4" /> 介绍
        </Link>
      </nav>
    </div>
  )
}
