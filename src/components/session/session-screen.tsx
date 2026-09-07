"use client"

import dynamic from "next/dynamic"
import {
  ArrowLeft,
  CameraOff,
  Check,
  Circle,
  Clock3,
  Eye,
  Flag,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useBehaviorEvents,
  useEventMutations,
  usePauseSessionForNavigation,
  useSession,
  useSessionMutations,
  useSettings,
  useTask,
  useTaskMutations,
} from "@/hooks/use-study-data"
import {
  areTaskStepsComplete,
  formatDuration,
  type BehaviorEvent,
  type TaskStep,
} from "@/lib/domain"
import {
  createRunningCheckpoint,
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
  const pauseForNavigation = usePauseSessionForNavigation()
  const eventMutations = useEventMutations(sessionId)
  const taskMutations = useTaskMutations()
  const [timer, dispatch] = useReducer(timerReducer, {
    mode: "paused",
    accumulatedMs: 0,
    anchorMs: null,
    displaySeconds: 0,
  } satisfies TimerState)
  const timerRef = useRef<TimerState | null>(null)
  const persistedResumedAtRef = useRef<string | null>(null)
  const stateVersionRef = useRef(0)
  const cameraVersionRef = useRef(0)
  const screenMountedRef = useRef(false)
  const pauseForNavigationRef = useRef(pauseForNavigation.mutateAsync)
  const terminalNavigationRef = useRef(false)
  const [finishing, setFinishing] = useState(false)
  const [finishDialogOpen, setFinishDialogOpen] = useState(false)
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  useLayoutEffect(() => {
    timerRef.current = timer
  }, [timer])

  useEffect(() => {
    pauseForNavigationRef.current = pauseForNavigation.mutateAsync
  }, [pauseForNavigation.mutateAsync])

  useEffect(() => {
    if (!sessionQuery.data) return
    persistedResumedAtRef.current = sessionQuery.data.resumed_at
    stateVersionRef.current = Math.max(
      stateVersionRef.current,
      sessionQuery.data.state_version,
    )
    cameraVersionRef.current = Math.max(
      cameraVersionRef.current,
      sessionQuery.data.camera_version,
    )
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
      const checkpoint = createRunningCheckpoint(current, now)
      const expectedResumedAt = persistedResumedAtRef.current
      if (!checkpoint || !expectedResumedAt) return
      void sessionMutations.checkpoint
        .mutateAsync({
          sessionId,
          expectedResumedAt,
          accumulatedSeconds: checkpoint.accumulatedSeconds,
          checkpointedAt: checkpoint.resumedAt,
        })
        .then((saved) => {
          if (saved.state_version < stateVersionRef.current) return
          stateVersionRef.current = saved.state_version
          cameraVersionRef.current = Math.max(
            cameraVersionRef.current,
            saved.camera_version,
          )
          if (saved.status === "running" && saved.resumed_at)
            persistedResumedAtRef.current = saved.resumed_at
        })
        .catch(() => undefined)
    }
    document.addEventListener("visibilitychange", persist)
    return () => document.removeEventListener("visibilitychange", persist)
  }, [sessionId, sessionMutations.checkpoint])

  useEffect(() => {
    if (!sessionQuery.data?.user_id) return
    screenMountedRef.current = true
    return () => {
      screenMountedRef.current = false
      queueMicrotask(() => {
        if (screenMountedRef.current) return
        const current = timerRef.current
        if (!current || current.mode !== "running") return
        void pauseForNavigationRef.current(sessionId).catch(() => undefined)
      })
    }
  }, [sessionId, sessionQuery.data?.user_id])

  useEffect(() => {
    const status = sessionQuery.data?.status
    if (
      !terminalNavigationRef.current &&
      (status === "completed" || status === "cancelled")
    ) {
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

  const pause = async (): Promise<boolean> => {
    const current = timerRef.current
    if (!current) return false
    const now = Date.now()
    const accumulated = elapsedSeconds(current, now)
    dispatch({ type: "pause", nowMs: now })
    try {
      let saved = await sessionMutations.pause.mutateAsync({
        sessionId,
        expectedStateVersion: stateVersionRef.current,
        accumulatedSeconds: accumulated,
      })
      for (
        let attempt = 1;
        saved.status === "running" && attempt < 3;
        attempt += 1
      )
        saved = await sessionMutations.pause.mutateAsync({
          sessionId,
          expectedStateVersion: saved.state_version,
          accumulatedSeconds: accumulated,
        })

      stateVersionRef.current = Math.max(
        stateVersionRef.current,
        saved.state_version,
      )
      if (saved.status === "running") {
        dispatch({ type: "restore", state: createTimerState(saved) })
        toast.error("学习状态正在另一个页面变化，请再试一次")
        return false
      }
      toast.info("学习已暂停")
      return true
    } catch (error) {
      dispatch({ type: "restore", state: current })
      toast.error(error instanceof Error ? error.message : "暂停失败")
      return false
    }
  }

  const pauseAndReturn = async () => {
    if (await pause()) router.push("/app")
  }

  const resume = async () => {
    const now = Date.now()
    dispatch({ type: "resume", nowMs: now })
    try {
      const saved = await sessionMutations.resume.mutateAsync({
        sessionId,
        expectedStateVersion: stateVersionRef.current,
      })
      stateVersionRef.current = Math.max(
        stateVersionRef.current,
        saved.state_version,
      )
      dispatch({ type: "restore", state: createTimerState(saved) })
      if (saved.status !== "running") {
        toast.info("学习状态已在另一个页面更新，请确认后再继续")
        return
      }
      toast.success("继续这一段学习")
    } catch (error) {
      dispatch({ type: "pause", nowMs: Date.now() })
      toast.error(error instanceof Error ? error.message : "恢复失败")
    }
  }

  const finish = async () => {
    if (!areTaskStepsComplete(task.steps)) {
      toast.info("完成全部任务步骤后，才可以结束并复盘")
      return
    }
    const current = timerRef.current
    if (!current) return
    setFinishing(true)
    terminalNavigationRef.current = true
    const now = Date.now()
    const accumulated = elapsedSeconds(current, now)
    dispatch({ type: "finish", nowMs: now })
    try {
      await sessionMutations.finish.mutateAsync({
        sessionId,
        accumulatedSeconds: accumulated,
        taskOutcome: "completed",
      })
      setFinishDialogOpen(false)
      router.push(`/app/review/${sessionId}`)
    } catch (error) {
      terminalNavigationRef.current = false
      dispatch({ type: "restore", state: current })
      toast.error(error instanceof Error ? error.message : "结束学习失败")
      setFinishing(false)
    }
  }

  const cancelCurrentSession = async (openReview: boolean) => {
    const current = timerRef.current
    if (!current || current.mode !== "paused") {
      toast.info("请先暂停，再结束本次学习")
      return
    }
    setCancelling(true)
    terminalNavigationRef.current = true
    const now = Date.now()
    const accumulated = elapsedSeconds(current, now)
    dispatch({ type: "finish", nowMs: now })
    try {
      await sessionMutations.cancel.mutateAsync({
        sessionId,
        accumulatedSeconds: accumulated,
      })
      setCancelDialogOpen(false)
      router.push(openReview ? `/app/review/${sessionId}` : "/app")
    } catch (error) {
      terminalNavigationRef.current = false
      dispatch({ type: "restore", state: current })
      toast.error(error instanceof Error ? error.message : "结束本次学习失败")
      setCancelling(false)
    }
  }

  const toggleStep = async (stepId: string, completed: boolean) => {
    try {
      await taskMutations.step.mutateAsync({
        taskId: task.id,
        stepId,
        completed,
      })
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
  const allStepsCompleted = areTaskStepsComplete(task.steps)
  const stepProgress = task.steps.length
    ? (completedSteps / task.steps.length) * 100
    : 0

  return (
    <>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 -ml-2"
            onClick={() => void pauseAndReturn()}
            disabled={
              sessionMutations.pause.isPending ||
              sessionMutations.resume.isPending
            }
          >
            <ArrowLeft /> 返回任务台
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">学习会话</Badge>
            {session.observation_profile === "off_device_v1" ? (
              <Badge className="border border-indigo-100 bg-indigo-50 text-indigo-700">
                <CameraOff /> 离设备任务 · 无摄像头
              </Badge>
            ) : null}
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
          {allStepsCompleted ? (
            <Button
              onClick={() => setFinishDialogOpen(true)}
              disabled={finishing}
            >
              <Flag /> 结束并复盘
            </Button>
          ) : timer.mode === "running" ? (
            <Button
              variant="outline"
              onClick={() => void pauseAndReturn()}
              disabled={
                sessionMutations.pause.isPending ||
                sessionMutations.resume.isPending
              }
            >
              <Pause /> 暂停并返回
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => void pauseAndReturn()}
                disabled={
                  sessionMutations.pause.isPending ||
                  sessionMutations.resume.isPending
                }
              >
                <ArrowLeft /> 返回任务台
              </Button>
              <Button
                variant="secondary"
                onClick={() => setCancelDialogOpen(true)}
              >
                <Square /> 结束本次学习
              </Button>
            </>
          )}
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
                    disabled={
                      sessionMutations.pause.isPending ||
                      sessionMutations.resume.isPending
                    }
                  >
                    <Pause /> 暂停
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className="h-12 min-w-40"
                    onClick={() => void resume()}
                    disabled={
                      sessionMutations.pause.isPending ||
                      sessionMutations.resume.isPending
                    }
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
              <p
                className={`mt-3 rounded-xl px-4 py-3 text-sm ${
                  allStepsCompleted
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-indigo-50 text-indigo-700"
                }`}
              >
                {allStepsCompleted
                  ? "全部步骤已完成，现在可以结束学习并进入复盘。"
                  : `还剩 ${task.steps.length - completedSteps} 个步骤。当前先暂停，下次会从这里继续。`}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <VisionPanel
            sessionId={sessionId}
            paused={timer.mode !== "running"}
            experimentMode={session.experiment_mode}
            observationProfile={session.observation_profile}
            settings={settingsQuery.data}
            onCameraStateChange={(enabled) => {
              const cameraVersion = cameraVersionRef.current + 1
              cameraVersionRef.current = cameraVersion
              void sessionMutations.camera
                .mutateAsync({
                  sessionId,
                  expectedStateVersion: stateVersionRef.current,
                  cameraVersion,
                  enabled,
                })
                .then((saved) => {
                  stateVersionRef.current = Math.max(
                    stateVersionRef.current,
                    saved.state_version,
                  )
                  cameraVersionRef.current = Math.max(
                    cameraVersionRef.current,
                    saved.camera_version,
                  )
                })
                .catch(() => undefined)
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

      <Dialog
        open={finishDialogOpen}
        onOpenChange={(open) => {
          if (!finishing) setFinishDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>确认完成这个任务？</DialogTitle>
            <DialogDescription>
              所有步骤均已完成。本次计时会立即保存并进入复盘；复盘仍可跳过。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium text-indigo-950">步骤进度</span>
              <span className="font-mono text-indigo-700">
                {completedSteps}/{task.steps.length}
              </span>
            </div>
            <Progress value={stepProgress} className="mt-3" />
            <p className="mt-3 text-sm leading-6 text-slate-600">
              全部步骤已完成，结束后任务会进入“已完成”，不能再次直接开始。
            </p>
          </div>
          <DialogFooter className="gap-2 sm:flex-col">
            <Button
              type="button"
              className="w-full"
              onClick={() => void finish()}
              disabled={finishing}
            >
              {finishing ? <RotateCcw className="animate-spin" /> : <Check />}
              确认结束并复盘
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setFinishDialogOpen(false)}
              disabled={finishing}
            >
              继续学习
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={cancelDialogOpen}
        onOpenChange={(open) => {
          if (!cancelling) setCancelDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>结束这一段学习？</DialogTitle>
            <DialogDescription>
              这只结束当前 session，不会把“{task.title}
              ”标记为完成。已勾选步骤会保留，下次开始会创建一段新的学习记录。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4 text-sm leading-6 text-slate-700">
            当前完成 {completedSteps}/{task.steps.length} 个步骤，已计时{" "}
            {formatDuration(timer.displaySeconds)}
            。你可以现在做一次简短复盘，也可以直接返回任务台。
          </div>
          <DialogFooter className="gap-2 sm:flex-col">
            <Button
              type="button"
              className="w-full"
              onClick={() => void cancelCurrentSession(true)}
              disabled={cancelling}
            >
              {cancelling ? <RotateCcw className="animate-spin" /> : <Flag />}
              结束并简短复盘
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void cancelCurrentSession(false)}
              disabled={cancelling}
            >
              <ArrowLeft /> 结束并返回任务台
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setCancelDialogOpen(false)}
              disabled={cancelling}
            >
              继续保留暂停状态
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
