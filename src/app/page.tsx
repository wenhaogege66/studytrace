import type { LucideIcon } from "lucide-react"
import {
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  CircleDotDashed,
  Clock3,
  Code2,
  Database,
  EyeOff,
  ListChecks,
  LockKeyhole,
  RefreshCcw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Workflow,
} from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

type Feature = {
  icon: LucideIcon
  title: string
  description: string
}

const loop: Feature[] = [
  {
    icon: ListChecks,
    title: "学习前 · 把任务变具体",
    description:
      "写明目标、拆成可执行步骤，标记优先级与预计时长，减少“知道要学但不知从哪开始”。",
  },
  {
    icon: Clock3,
    title: "学习中 · 计时与轻观察",
    description:
      "稳定计时；摄像头可选开启。模型只在浏览器本地观察“未在画面”或“头部方向明显变化”。",
  },
  {
    icon: RefreshCcw,
    title: "学习后 · 做一次可行动复盘",
    description:
      "对照预计与实际时长，确认或修正事件，写下未完成原因和下一次只改一件事。",
  },
]

const principles: Feature[] = [
  {
    icon: EyeOff,
    title: "画面不离开设备",
    description: "视频、图片、音频、人脸关键点与人脸特征都不上传、不保存。",
  },
  {
    icon: CircleDotDashed,
    title: "不做专注分数",
    description: "事件是可复盘线索，不代表“走神”、能力、ADHD 或任何医学判断。",
  },
  {
    icon: LockKeyhole,
    title: "身份可选且逐行隔离",
    description:
      "临时身份与邮箱账号都使用 RLS；每次查询都受 auth.uid() 所有权约束。",
  },
  {
    icon: TimerReset,
    title: "可删除、会过期",
    description:
      "事件可确认、改写或硬删除；临时身份连续 30 天无活动后才会清理。",
  },
]

export default function Home() {
  return (
    <main className="overflow-hidden">
      <header className="relative z-20 border-b border-indigo-100/70 bg-white/65 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-5 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5"
            aria-label="学迹首页"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-indigo-700 text-white shadow-md shadow-indigo-900/15">
              <BookOpenCheck className="size-5" />
            </span>
            <span className="font-semibold tracking-tight text-slate-950">
              学迹 StudyTrace
            </span>
          </Link>
          <nav
            className="hidden items-center gap-6 text-sm text-slate-600 md:flex"
            aria-label="页面章节"
          >
            <a href="#loop" className="hover:text-indigo-700">
              学习闭环
            </a>
            <a href="#technology" className="hover:text-indigo-700">
              技术架构
            </a>
            <a href="#privacy" className="hover:text-indigo-700">
              隐私边界
            </a>
          </nav>
          <Button asChild>
            <Link href="/app">
              开始体验 <ArrowRight />
            </Link>
          </Button>
        </div>
      </header>

      <section className="relative px-5 py-20 sm:py-28">
        <div className="page-orb page-orb-left" />
        <div className="page-orb page-orb-right" />
        <div className="relative mx-auto grid w-full max-w-7xl items-center gap-14 lg:grid-cols-[1.08fr_0.92fr]">
          <div>
            <Badge
              variant="outline"
              className="mb-6 border-indigo-200 bg-white/70 px-3 py-1.5 text-indigo-800"
            >
              <Sparkles className="size-3.5" /> StudyTrace v0.1 · 可运行产品
            </Badge>
            <h1 className="max-w-4xl text-5xl leading-[1.06] font-semibold tracking-[-0.04em] text-balance text-slate-950 sm:text-6xl lg:text-7xl">
              让一次学习，留下可以调整的
              <span className="text-indigo-700">迹</span>。
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-pretty text-slate-600 sm:text-xl">
              学迹
              StudyTrace——基于计算机视觉的任务管理与注意状态识别一体化学习辅助系统。它把任务拆分、稳定计时、本地视觉观察与一次复盘连成闭环。
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button size="lg" className="h-11 px-5" asChild>
                <Link href="/app">
                  进入真实体验 <ArrowRight />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-11 border-indigo-200 bg-white/70 px-5"
                asChild
              >
                <a
                  href="https://github.com/wenhaogege66/studytrace"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Code2 /> 查看公开代码
                </a>
              </Button>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-slate-500">
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-600" />{" "}
                无需注册即可体验
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-600" />{" "}
                摄像头完全可选
              </span>
              <span className="inline-flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-600" />{" "}
                失败仍可完整复盘
              </span>
            </div>
          </div>

          <div className="relative lg:pl-4">
            <div className="absolute -inset-6 rounded-[2.5rem] bg-gradient-to-br from-indigo-200/50 via-transparent to-emerald-200/50 blur-2xl" />
            <Card className="relative overflow-hidden border-white/90 bg-white/90 shadow-2xl shadow-indigo-950/10">
              <div className="session-grid border-b bg-indigo-50/50 px-6 py-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium tracking-[0.14em] text-indigo-700 uppercase">
                      Now learning
                    </p>
                    <h2 className="mt-1 font-semibold text-slate-950">
                      完成光合作用实验复盘
                    </h2>
                  </div>
                  <Badge className="bg-emerald-100 text-emerald-800">
                    本地观察中
                  </Badge>
                </div>
                <div className="py-10 text-center">
                  <p className="font-mono text-6xl font-medium tracking-tight text-slate-950 sm:text-7xl">
                    24:18
                  </p>
                  <p className="mt-2 text-sm text-slate-500">
                    预计 35 分钟 · 第 2 / 3 步
                  </p>
                </div>
              </div>
              <CardContent className="space-y-4 p-6">
                <div className="flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-emerald-950">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <p className="font-medium">当前状态：中性姿态</p>
                    <p className="mt-1 text-sm text-emerald-800">
                      帧在浏览器本地处理，网络中没有视频上传。
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border p-4">
                    <p className="text-2xl font-semibold text-slate-950">2</p>
                    <p className="mt-1 text-xs text-slate-500">可复盘事件</p>
                  </div>
                  <div className="rounded-xl border p-4">
                    <p className="text-2xl font-semibold text-slate-950">0</p>
                    <p className="mt-1 text-xs text-slate-500">原始媒体记录</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <section className="content-auto border-y border-indigo-100/70 bg-white/70 px-5 py-20">
        <div className="mx-auto grid w-full max-w-7xl gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
          <div>
            <p className="section-kicker">Problem / 问题背景</p>
            <h2 className="text-3xl font-semibold tracking-tight text-balance text-slate-950 sm:text-4xl">
              学习记录常常只留下“做了多久”，却没有留下“下一次怎么更好”。
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["目标模糊", "任务停在“复习”“写作业”，真正的第一步仍不明确。"],
              [
                "过程不可见",
                "计时器知道时长，却不知道中途何时离开、何时需要回到任务。",
              ],
              [
                "复盘无抓手",
                "只凭印象评价“今天不专注”，很难形成可验证的调整。",
              ],
            ].map(([title, description], index) => (
              <Card
                key={title}
                className="border-indigo-100 bg-white/85 shadow-sm"
              >
                <CardHeader>
                  <span className="font-mono text-xs text-indigo-500">
                    0{index + 1}
                  </span>
                  <CardTitle className="text-lg">{title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-6 text-slate-600">
                  {description}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section id="loop" className="content-auto px-5 py-24">
        <div className="mx-auto w-full max-w-7xl">
          <p className="section-kicker">Closed loop / 学习闭环</p>
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance text-slate-950 sm:text-4xl">
              把“计划—执行—调整”做成一条完整路径。
            </h2>
            <p className="max-w-md text-sm leading-6 text-slate-600">
              视觉观察不是产品中心，只是学习中段的一种可选数据来源；没有摄像头，闭环依然完整。
            </p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {loop.map(({ icon: Icon, title, description }, index) => (
              <Card
                key={title}
                className="group relative overflow-hidden border-indigo-100 bg-white/85 shadow-sm transition-transform hover:-translate-y-1"
              >
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo-600 via-indigo-400 to-emerald-400 opacity-70" />
                <CardHeader>
                  <div className="mb-4 flex items-center justify-between">
                    <span className="grid size-11 place-items-center rounded-2xl bg-indigo-50 text-indigo-700">
                      <Icon className="size-5" />
                    </span>
                    <span className="font-mono text-sm text-slate-300">
                      0{index + 1}
                    </span>
                  </div>
                  <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardContent className="leading-7 text-slate-600">
                  {description}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section
        id="technology"
        className="content-auto bg-indigo-950 px-5 py-24 text-indigo-50"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-14 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="mb-3 text-xs font-semibold tracking-[0.18em] text-emerald-300 uppercase">
              Architecture / 技术架构
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              高频视觉帧留在 Worker，结构化事件才进入数据库。
            </h2>
            <p className="mt-5 leading-7 text-indigo-200">
              静态公开首页与动态应用区分开；计算、存储和权限边界都有明确职责。
            </p>
            <Button variant="secondary" className="mt-8" asChild>
              <a
                href="https://github.com/wenhaogege66/studytrace"
                target="_blank"
                rel="noreferrer"
              >
                <Code2 /> 阅读实现
              </a>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              [
                Workflow,
                "Next.js 16 + React 19",
                "App Router 承载静态介绍与动态应用，TanStack Query 管理远程状态。",
              ],
              [
                ScanFace,
                "MediaPipe Web Worker",
                "Face Landmarker 按需加载，以约 4 FPS 推理，滚动窗口去抖。",
              ],
              [
                Database,
                "Supabase Postgres",
                "匿名身份、RLS、外键级联、活动会话唯一约束与 30 天清理。",
              ],
              [
                ShieldCheck,
                "可审计交付链",
                "TypeScript、Vitest、Playwright、GitHub Actions 与 Vercel Preview。",
              ],
            ].map(([Icon, title, description]) => (
              <div
                key={String(title)}
                className="rounded-2xl border border-indigo-800 bg-indigo-900/65 p-5"
              >
                <Icon className="mb-5 size-6 text-emerald-300" />
                <h3 className="font-semibold text-white">{title as string}</h3>
                <p className="mt-2 text-sm leading-6 text-indigo-200">
                  {description as string}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="privacy" className="content-auto px-5 py-24">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mx-auto max-w-3xl text-center">
            <p className="section-kicker">Privacy / 隐私原则</p>
            <h2 className="text-3xl font-semibold tracking-tight text-balance text-slate-950 sm:text-4xl">
              从“不该收集什么”开始设计。
            </h2>
            <p className="mt-5 leading-7 text-slate-600">
              学迹只需要足够支持复盘的最小事件数据，不需要保留能够重建人脸或学习场景的原始材料。
            </p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {principles.map(({ icon: Icon, title, description }) => (
              <Card key={title} className="border-indigo-100 bg-white/85">
                <CardHeader>
                  <span className="mb-2 grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                    <Icon className="size-5" />
                  </span>
                  <CardTitle className="text-lg">{title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-6 text-slate-600">
                  {description}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="content-auto border-y border-indigo-100 bg-white/70 px-5 py-20">
        <div className="mx-auto w-full max-w-7xl">
          <p className="section-kicker">Roadmap / 版本里程碑</p>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              [
                "v0.1 · 当前",
                "完整任务—会话—复盘闭环；本地视觉观察；匿名安全数据层。",
                true,
              ],
              [
                "v0.2 · 下一步",
                "更多手动观察维度、复盘趋势视图与可解释阈值校准。",
                false,
              ],
              [
                "v0.3 · 验证后",
                "在明确同意前提下探索跨设备恢复与数据导出，不改变本地视觉原则。",
                false,
              ],
            ].map(([title, description, current]) => (
              <div
                key={String(title)}
                className="rounded-2xl border border-indigo-100 bg-white p-6"
              >
                <Badge variant={current ? "default" : "secondary"}>
                  {current ? "已实现" : "规划中"}
                </Badge>
                <h3 className="mt-4 font-semibold text-slate-950">
                  {title as string}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {description as string}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-24">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-[2rem] bg-indigo-700 px-6 py-12 text-center text-white shadow-2xl shadow-indigo-950/20 sm:px-12 sm:py-16">
          <BrainCircuit className="mx-auto size-9 text-emerald-300" />
          <h2 className="mx-auto mt-5 max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            现在就完成一轮真实学习闭环。
          </h2>
          <p className="mx-auto mt-4 max-w-2xl leading-7 text-indigo-100">
            创建匿名会话，自己建任务或主动载入示例数据。摄像头拒绝、模型失败或移动设备上，都可以继续计时与手动复盘。
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button size="lg" variant="secondary" asChild>
              <Link href="/app">
                开始体验 <ArrowRight />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="border-indigo-300 bg-transparent text-white hover:bg-indigo-600 hover:text-white"
              asChild
            >
              <a
                href="https://github.com/wenhaogege66/studytrace"
                target="_blank"
                rel="noreferrer"
              >
                <Code2 /> GitHub
              </a>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-indigo-100 bg-white/70 px-5 py-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>学迹 StudyTrace · 隐私优先的学习辅助实验产品</p>
          <div className="flex items-center gap-4">
            <a
              href="https://nextjs.org/docs/app"
              target="_blank"
              rel="noreferrer"
              className="hover:text-indigo-700"
            >
              Next.js
            </a>
            <Separator orientation="vertical" className="h-4" />
            <a
              href="https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js"
              target="_blank"
              rel="noreferrer"
              className="hover:text-indigo-700"
            >
              MediaPipe
            </a>
            <Separator orientation="vertical" className="h-4" />
            <a
              href="https://supabase.com/docs/guides/auth/auth-anonymous"
              target="_blank"
              rel="noreferrer"
              className="hover:text-indigo-700"
            >
              Supabase
            </a>
          </div>
        </div>
      </footer>
    </main>
  )
}
