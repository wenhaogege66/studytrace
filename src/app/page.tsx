import type { LucideIcon } from "lucide-react"
import {
  ArrowRight,
  BookOpenCheck,
  BrainCircuit,
  ChartNoAxesCombined,
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
    title: "设计任务 · AI 先拆出第一版",
    description:
      "说清目标后，由 AI 生成可编辑的步骤初稿；你再调整顺序、优先级与预计时长。",
  },
  {
    icon: Clock3,
    title: "持续执行 · 分多次推进",
    description:
      "一个大任务可以跨多次执行会话继续。计时稳定保留，摄像头观察与轻提醒完全可选。",
  },
  {
    icon: RefreshCcw,
    title: "回看过程 · 每次都可复盘",
    description:
      "每次结束后都可确认或修正客观事件，写下下一次调整；暂时不复盘也不阻断任务推进。",
  },
  {
    icon: ChartNoAxesCombined,
    title: "积累规律 · 样本足够再建议",
    description:
      "近 30 天至少积累 20 个有效投入片段和 10 个活跃日，才给出工作—休息区间与较适合时段；不足时只显示收集进度。",
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
              执行闭环
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
              <Sparkles className="size-3.5" /> StudyTrace v0.2 · 可运行产品
            </Badge>
            <h1 className="max-w-4xl text-5xl leading-[1.06] font-semibold tracking-[-0.04em] text-balance text-slate-950 sm:text-6xl lg:text-7xl">
              让每一次行动，留下可以调整的
              <span className="text-indigo-700">迹</span>。
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-pretty text-slate-600 sm:text-xl">
              学迹 StudyTrace 不是普通待办或监考工具。它把任务设计、AI
              拆解、多次执行、本地过程观察、单次复盘与长期规律连成一条自律执行闭环。
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
                样本足够才形成建议
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
                      In progress / 正在执行
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
              自律不只需要一张计划表，还需要看见自己怎样执行、下一次改什么。
            </h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["目标模糊", "任务停在“复习”“锻炼”，真正的第一步仍不明确。"],
              [
                "过程不可见",
                "计时器知道总时长，却很难说明任务如何被分段推进、何时需要调整。",
              ],
              [
                "复盘无抓手",
                "只凭印象评价自己，很难把一次经验积累成可验证的个人规律。",
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
          <p className="section-kicker">Closed loop / 自律执行闭环</p>
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance text-slate-950 sm:text-4xl">
              从一个目标开始，逐步形成自己的行动依据。
            </h2>
            <p className="max-w-md text-sm leading-6 text-slate-600">
              视频观察只是一种可选的客观信号；没有摄像头，任务、执行、复盘与长期记录依然完整。
            </p>
          </div>
          <ol className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-indigo-100 bg-indigo-100 shadow-sm sm:grid-cols-2 lg:grid-cols-4">
            {loop.map(({ icon: Icon, title, description }, index) => (
              <li
                key={title}
                className="relative bg-white/95 p-5 sm:min-h-56 sm:p-6 lg:min-h-64"
              >
                <div className="flex items-center justify-between">
                  <span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-700">
                    <Icon className="size-5" />
                  </span>
                  <span className="font-mono text-xs tracking-wider text-indigo-400">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-slate-950 sm:mt-7">
                  {title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  {description}
                </p>
                {index < loop.length - 1 ? (
                  <ArrowRight className="absolute right-[-0.75rem] bottom-6 z-10 hidden size-6 rounded-full bg-white p-1 text-indigo-300 shadow-sm ring-1 ring-indigo-100 lg:block" />
                ) : null}
              </li>
            ))}
          </ol>
          <p className="mt-5 flex max-w-4xl items-start gap-2 text-sm leading-6 text-slate-600">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" />
            少于 2
            分钟的碎片段、模拟数据和未经确认的视觉事件不参与规律判断；“前置信号”至少需要
            10 次用户主动标记。
          </p>
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
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[
              [
                "v0.1 · 基础闭环",
                "完整任务—会话—复盘闭环；本地视觉观察；匿名安全数据层。",
                true,
              ],
              [
                "v0.1.1 · 任务连续性",
                "横向任务工作台、待确认完成、多次 Session 与可选邮箱跨设备同步。",
                true,
              ],
              [
                "v0.2 · 事实型洞察",
                "展示投入片段、时段、复盘与用户确认事件，并在样本足够后给出实验建议。",
                true,
              ],
              [
                "v0.3 · 下一步",
                "探索数据导出、明确同意后的聚合 AI 报告，以及独立的全身运动识别实验。",
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
            从一个真实任务开始，留下第一条行动记录。
          </h2>
          <p className="mx-auto mt-4 max-w-2xl leading-7 text-indigo-100">
            无需注册即可设计任务、分次执行并选择是否复盘。记录积累到最低样本量后，再查看只属于你的事实型规律。
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button size="lg" variant="secondary" asChild>
              <Link href="/app">
                开始一次执行 <ArrowRight />
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
          <p>学迹 StudyTrace · 隐私优先的自律执行工具</p>
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
