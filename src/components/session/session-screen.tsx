"use client"

import dynamic from "next/dynamic"
import {
  ArrowLeft,
  Check,
  Circle,
  Clock3,
  Eye,
  Flag,
  Pause,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useReducer, useRef, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useBehaviorEvents,
  useEventMutations,
  useSession,
  useSessionMutations,
  useSettings,
  useTask,
  useTaskMutations,
} from "@/hooks/use-study-data"
import {
  formatDuration,
  type BehaviorEvent,
  type TaskStep,
  type TaskDraft,
} from "@/lib/domain"
import {
  createTimerState,
  elapsedSeconds,
  timerReducer,
  type TimerState,
} from "@/lib/session/timer"

const VisionPanel = dynamic(
  () =>
    import("@/components/session/vision-panel").then(
      (module) => module.VisionPanel,
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="aspect-video w-full rounded-2xl" />,
  },
)

function eventLabel(event: BehaviorEvent) {
  if (event.source === "simulation") return "模拟事件"
  if (event.event_type === "face_absent") return "未在画面"
  if (event.event_type === "manual") return "手动标记"
  const directions: Record<string, string> = {
    left: "向左",
    right: "向右",
    down: "低头",
    unknown: "方向变化",
  }
  return `头部方向变化 · ${directions[event.direction ?? "unknown"]}`
}

function SessionLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-16 w-96 max-w-full" />
      <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <Skeleton className="h-[32rem]" />
        <Skeleton className="h-[32rem]" />
      </div>
    </div>
  )
}

export function SessionScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const sessionQuery = useSession(sessionId)
  const taskQuery = useTask(sessionQuery.data?.task_id)
  const eventsQuery = useBehaviorEvents(sessionId)
  const settingsQuery = useSettings()
  const sessionMutations = useSessionMutations()
  const eventMutations = useEventMutations(sessionId)
  const taskMutations = useTaskMutations()
  const [timer, dispatch] = useReducer(timerReducer, {
    mode: "paused",
    accumulatedMs: 0,
    anchorMs: null,
    displaySeconds: 0,
  } satisfies TimerState)
  const timerRef = useRef<TimerState | null>(null)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    timerRef.current = timer
  }, [timer])

  useEffect(() => {
    if (!sessionQuery.data) return
    dispatch({ type: "restore", state: createTimerState(sessionQuery.data) })
  }, [sessionQuery.data])

  useEffect(() => {
    if (timer?.mode !== "running") return
    const interval = setInterval(
      () => dispatch({ type: "tick", nowMs: Date.now() }),
      1_000,
    )
    return () => clearInterval(interval)
  }, [timer?.mode])

  useEffect(() => {
    const persist = () => {
      const current = timerRef.current
      if (
        document.visibilityState !== "hidden" ||
        !current ||
        current.mode !== "running"
      )
        return
      const now = Date.now()
      void sessionMutations.update.mutateAsync({
        sessionId,
        update: {
          accumulated_seconds: elapsedSeconds(current, now),
          resumed_at: new Date(now).toISOString(),
          status: "running",
        },
      })
    }
    document.addEventListener("visibilitychange", persist)
    return () => document.removeEventListener("visibilitychange", persist)
  }, [sessionId, sessionMutations.update])

  useEffect(() => {
    const status = sessionQuery.data?.status
    if (status === "completed" || status === "cancelled") {
      router.replace(`/app/review/${sessionId}`)
    }
  }, [router, sessionId, sessionQuery.data?.status])

  if (sessionQuery.isLoading || (sessionQuery.data && taskQuery.isLoading))
    return <SessionLoading />

  if (sessionQuery.isError || taskQuery.isError) {
    const message =
      sessionQuery.error?.message ?? taskQuery.error?.message ?? "未知错误"
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>学习会话没有加载出来</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/app">
              <ArrowLeft /> 返回任务
            </Link>
          </Button>
          <Button onClick={() => void sessionQuery.refetch()}>
            <RotateCcw /> 重试
          </Button>
        </CardContent>
      </Card>
    )
  }

  const session = sessionQuery.data
  const task = taskQuery.data
  if (!session || !task) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>这段学习不存在或已经被删除</CardTitle>
          <CardDescription>
            匿名数据只在当前浏览器会话中可恢复。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/app">
              <ArrowLeft /> 返回任务台
            </Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (session.status === "completed" || session.status === "cancelled") {
    return <SessionLoading />
  }

  const pause = async () => {
    const current = timerRef.current
    if (!current) return
    const now = Date.now()
    const accumulated = elapsedSeconds(current, now)
    dispatch({ type: "pause", nowMs: now })
    try {
      await sessionMutations.update.mutateAsync({
        sessionId,
        update: {
          status: "paused",
          accumulated_seconds: accumulated,
          resumed_at: null,
          camera_enabled: false,
        },
      })
      toast.info("学习已暂停")
    } catch (error) {
      dispatch({ type: "resume", nowMs: Date.now() })
      toast.error(error instanceof Error ? error.message : "暂停失败")
    }
  }

  const resume = async () => {
    const now = Date.now()
    dispatch({ type: "resume", nowMs: now })
    try {
      await sessionMutations.update.mutateAsync({
        sessionId,
        update: { status: "running", resumed_at: new Date(now).toISOString() },
      })
      toast.success("继续这一段学习")
    } catch (error) {
      dispatch({ type: "pause", nowMs: Date.now() })
      toast.error(error instanceof Error ? error.message : "恢复失败")
    }
  }

  const finish = async () => {
    const current = timerRef.current
    if (!current) return
    setFinishing(true)
    const now = Date.now()
    const accumulated = elapsedSeconds(current, now)
    dispatch({ type: "finish", nowMs: now })
    try {
      await sessionMutations.update.mutateAsync({
        sessionId,
        update: {
          status: "completed",
          accumulated_seconds: accumulated,
          ended_at: new Date(now).toISOString(),
          resumed_at: null,
          camera_enabled: false,
        },
      })
      router.push(`/app/review/${sessionId}`)
    } catch (error) {
      dispatch({ type: "restore", state: current })
      toast.error(error instanceof Error ? error.message : "结束学习失败")
      setFinishing(false)
    }
  }

  const toggleStep = async (stepId: string, completed: boolean) => {
    const draft: TaskDraft = {
      title: task.title,
      priority: task.priority,
      estimatedMinutes: task.estimated_minutes,
      steps: task.steps.map((step: TaskStep) =>
        step.id === stepId ? { ...step, completed } : step,
      ),
    }
    try {
      await taskMutations.update.mutateAsync({ taskId: task.id, draft })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "步骤状态未保存")
    }
  }

  const addManualEvent = async () => {
    const now = Date.now()
    try {
      await eventMutations.create.mutateAsync({
        type: "manual",
        source: "manual",
        startedAt: new Date(now).toISOString(),
        endedAt: new Date(now + 1_000).toISOString(),
      })
      toast.success("已添加一条手动标记")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "标记失败")
    }
  }

  const completedSteps = task.steps.filter(
    (step: TaskStep) => step.completed,
  ).length
  const stepProgress = task.steps.length
    ? (completedSteps / task.steps.length) * 100
    : 0

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild>
            <Link href="/app">
              <ArrowLeft /> 返回任务台
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">学习会话</Badge>
            {session.experiment_mode ? (
              <Badge className="bg-amber-100 text-amber-800">
                技术实验模式
              </Badge>
            ) : null}
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            {task.title}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void addManualEvent()}>
            <Plus /> 手动标记
          </Button>
          <Button
            variant="destructive"
            onClick={() => void finish()}
            disabled={finishing}
          >
            <Flag /> 结束并复盘
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-6">
          <Card className="session-grid overflow-hidden border-indigo-100 bg-white/92 shadow-lg shadow-indigo-950/5">
            <CardContent className="p-6 sm:p-8">
              <div className="flex items-center justify-between text-sm text-slate-500">
                <span className="flex items-center gap-2">
                  <span
                    className={`size-2.5 rounded-full ${timer.mode === "running" ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`}
                  />
                  {timer.mode === "running" ? "计时中" : "已暂停"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock3 className="size-4" /> 预计 {task.estimated_minutes}{" "}
                  分钟
                </span>
              </div>
              <div className="py-12 text-center sm:py-16">
                <p
                  aria-live="off"
                  className="font-mono text-7xl font-medium tracking-[-0.06em] text-slate-950 tabular-nums sm:text-8xl"
                >
                  {formatDuration(timer.displaySeconds)}
                </p>
                <p className="mt-3 text-sm text-slate-500">
                  刷新页面也会根据已保存时间恢复
                </p>
              </div>
              <div className="flex justify-center">
                {timer.mode === "running" ? (
                  <Button
                    size="lg"
                    variant="outline"
                    className="h-12 min-w-40 bg-white"
                    onClick={() => void pause()}
                    disabled={sessionMutations.update.isPending}
                  >
                    <Pause /> 暂停
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className="h-12 min-w-40"
                    onClick={() => void resume()}
                    disabled={sessionMutations.update.isPending}
                  >
                    <Play /> 继续
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-indigo-100 bg-white/90 shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>当前任务步骤</CardTitle>
                  <CardDescription className="mt-1">
                    只关注眼前这一小步。
                  </CardDescription>
                </div>
                <span className="font-mono text-sm text-slate-500">
                  {completedSteps}/{task.steps.length}
                </span>
              </div>
              <Progress value={stepProgress} className="mt-3" />
            </CardHeader>
            <CardContent className="space-y-2">
              {task.steps.map((step: TaskStep) => (
                <label
                  key={step.id}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border border-transparent p-3 transition-colors hover:border-indigo-100 hover:bg-indigo-50/50"
                >
                  <Checkbox
                    checked={step.completed}
                    onCheckedChange={(checked) =>
                      void toggleStep(step.id, checked === true)
                    }
                  />
                  <span
                    className={
                      step.completed
                        ? "text-slate-400 line-through"
                        : "text-slate-700"
                    }
                  >
                    {step.title}
                  </span>
                </label>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <VisionPanel
            sessionId={sessionId}
            paused={timer.mode !== "running"}
            experimentMode={session.experiment_mode}
            settings={settingsQuery.data}
            onCameraStateChange={(enabled) => {
              void sessionMutations.update.mutateAsync({
                sessionId,
                update: { camera_enabled: enabled },
              })
            }}
          />

          <Card className="border-indigo-100 bg-white/90 shadow-sm">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Eye className="size-5 text-indigo-700" /> 本次事件
                  </CardTitle>
                  <CardDescription className="mt-1">
                    这些是线索，不是评价。
                  </CardDescription>
                </div>
                <Badge variant="secondary">
                  {eventsQuery.data?.length ?? 0}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {eventsQuery.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              ) : null}
              {!eventsQuery.isLoading && !eventsQuery.data?.length ? (
                <div className="rounded-xl border border-dashed p-5 text-center text-sm text-slate-500">
                  <Circle className="mx-auto mb-2 size-5" /> 还没有结构化事件
                </div>
              ) : null}
              <div className="space-y-2">
                {eventsQuery.data
                  ?.slice(-5)
                  .toReversed()
                  .map((event: BehaviorEvent) => (
                    <div
                      key={event.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-2 rounded-full ${event.ended_at ? "bg-slate-400" : "animate-pulse bg-amber-500"}`}
                        />
                        <span>{eventLabel(event)}</span>
                      </div>
                      <span className="font-mono text-xs text-slate-500">
                        {new Date(event.started_at).toLocaleTimeString(
                          "zh-CN",
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          },
                        )}
                      </span>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6 border-emerald-200 bg-emerald-50/70">
        <CardContent className="flex items-start gap-3 p-4 text-sm leading-6 text-emerald-950">
          <Check className="mt-0.5 size-4 shrink-0" />
          <p>
            <strong>隐私状态：</strong>浏览器只向 Supabase
            写入任务、计时和结构化事件。摄像头视频没有上传接口；关闭摄像头或离开页面会立即停止媒体轨道和
            Worker。
          </p>
        </CardContent>
      </Card>
    </>
  )
}
