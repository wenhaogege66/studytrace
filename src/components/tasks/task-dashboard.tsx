"use client"

import {
  Archive,
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock3,
  Copy,
  Ellipsis,
  ListPlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useActiveSession,
  useSessionMutations,
  useSettings,
  useTaskSessions,
  useTaskMutations,
  useTasks,
} from "@/hooks/use-study-data"
import { taskPlanSuggestionSchema } from "@/lib/ai/task-plan-contract"
import {
  areTaskStepsComplete,
  canStartTask,
  canStartTaskNow,
  createStep,
  formatMinutes,
  taskDisplayStatus,
  type Priority,
  type Task,
  type TaskDisplayStatus,
  type TaskDraft,
  type TaskStep,
} from "@/lib/domain"
import { getSupabase } from "@/lib/supabase/client"
import {
  getObservationProfile,
  observationProfiles,
  observationProfileValues,
  type ObservationProfile,
} from "@/lib/vision/profiles"

const priorityMeta: Record<Priority, { label: string; className: string }> = {
  high: { label: "高优先", className: "border-red-200 bg-red-50 text-red-700" },
  medium: {
    label: "中优先",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  low: {
    label: "低优先",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
}

const statusMeta: Record<
  TaskDisplayStatus,
  { label: string; className: string }
> = {
  not_started: {
    label: "未开始",
    className: "border-slate-200 bg-slate-50 text-slate-600",
  },
  in_progress: {
    label: "待继续",
    className: "border-indigo-100 bg-indigo-50 text-indigo-700",
  },
  running: {
    label: "计时中",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  paused: {
    label: "已暂停",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  ready_to_complete: {
    label: "待确认完成",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  completed: {
    label: "已完成",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  archived: {
    label: "已归档",
    className: "border-slate-200 bg-slate-100 text-slate-600",
  },
}

function TaskStateIcon({ status }: { status: TaskDisplayStatus }) {
  if (status === "completed")
    return <CheckCircle2 className="size-5 text-emerald-600" />
  if (status === "ready_to_complete")
    return <Check className="size-5 text-emerald-600" />
  if (status === "running") return <Play className="size-5 text-emerald-600" />
  if (status === "paused") return <Clock3 className="size-5 text-amber-600" />
  if (status === "archived")
    return <Archive className="size-5 text-slate-500" />
  return <Circle className="size-5 text-slate-400" />
}

function emptyDraft(): TaskDraft {
  return {
    title: "",
    steps: [createStep(""), createStep(""), createStep("")],
    priority: "medium",
    estimatedMinutes: 30,
    observationProfile: "study_screen_v1",
  }
}

function TaskDialog({
  open,
  onOpenChange,
  task,
  profileLocked,
  onSave,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task | null
  profileLocked: boolean
  onSave: (draft: TaskDraft) => Promise<void>
  saving: boolean
}) {
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task
      ? {
          title: task.title,
          steps: task.steps.length ? task.steps : [createStep("")],
          priority: task.priority,
          estimatedMinutes: task.estimated_minutes,
          observationProfile: task.observation_profile,
        }
      : emptyDraft(),
  )
  const [suggesting, setSuggesting] = useState(false)
  const [profileReason, setProfileReason] = useState<string | null>(null)
  const suggestionAbortRef = useRef<AbortController | null>(null)
  const validEstimate =
    Number.isInteger(draft.estimatedMinutes) &&
    draft.estimatedMinutes >= 1 &&
    draft.estimatedMinutes <= 480

  useEffect(
    () => () => {
      suggestionAbortRef.current?.abort()
    },
    [],
  )

  const updateStep = (id: string, update: Partial<TaskStep>) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === id ? { ...step, ...update } : step,
      ),
    }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanSteps = draft.steps
      .filter((step) => step.title.trim())
      .map((step) => ({ ...step, title: step.title.trim() }))
    if (!draft.title.trim()) {
      toast.error("请先写下任务标题")
      return
    }
    if (!cleanSteps.length) {
      toast.error("至少保留一个可执行步骤")
      return
    }
    if (!validEstimate) {
      toast.error("预计时长需为 1～480 分钟的整数")
      return
    }
    await onSave({ ...draft, title: draft.title.trim(), steps: cleanSteps })
  }

  const suggestPlan = async () => {
    if (task) {
      toast.info("AI 初稿只在新建任务时生成，避免覆盖已有完成进度")
      return
    }
    const title = draft.title.trim()
    if (!title) {
      toast.info("先写下任务标题，AI 才能帮你拆步骤")
      return
    }
    if (!validEstimate) {
      toast.info("先填写 1～480 分钟的预计时长")
      return
    }

    suggestionAbortRef.current?.abort()
    const controller = new AbortController()
    suggestionAbortRef.current = controller
    setSuggesting(true)
    try {
      const { data, error: sessionError } =
        await getSupabase().auth.getSession()
      if (sessionError || !data.session)
        throw new Error("匿名体验已失效，请刷新后重试")

      const response = await fetch("/api/tasks/suggest-plan", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          estimatedMinutes: draft.estimatedMinutes,
        }),
        cache: "no-store",
        signal: controller.signal,
      })
      const result: unknown = await response.json()
      if (!response.ok) {
        const message =
          result && typeof result === "object" && "error" in result
            ? String(result.error)
            : "AI 暂时无法生成初稿"
        throw new Error(message)
      }
      const parsed = taskPlanSuggestionSchema.safeParse(result)
      if (!parsed.success) throw new Error("AI 返回的初稿格式不正确")
      const suggestion = parsed.data

      setDraft((current) => ({
        ...current,
        steps: suggestion.steps.map(createStep),
        priority: suggestion.priority,
        estimatedMinutes: suggestion.estimatedMinutes,
        observationProfile: suggestion.observationProfile,
      }))
      setProfileReason(suggestion.profileReason)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      toast.error(error instanceof Error ? error.message : "AI 生成失败")
    } finally {
      if (suggestionAbortRef.current === controller) {
        suggestionAbortRef.current = null
        setSuggesting(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <form
          className="grid max-h-[90dvh] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
          onSubmit={(event) => void submit(event)}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pr-12 sm:px-6 sm:pt-5 sm:pr-12">
            <DialogTitle>{task ? "编辑任务" : "创建一项具体任务"}</DialogTitle>
            <DialogDescription>
              写下标题，让 AI 先给出三步初稿；每一步都可以继续修改。
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
            <div className="space-y-2">
              <Label htmlFor="task-title">任务标题</Label>
              <Input
                id="task-title"
                autoFocus
                maxLength={120}
                placeholder="例如：完成光合作用实验复盘"
                value={draft.title}
                disabled={suggesting}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>执行步骤</Label>
                <div className="flex items-center gap-1">
                  {task ? (
                    <span className="px-2 text-xs text-slate-500">
                      AI 初稿仅用于新建任务
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={
                        suggesting || !draft.title.trim() || !validEstimate
                      }
                      onClick={() => void suggestPlan()}
                    >
                      {suggesting ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Sparkles />
                      )}
                      {suggesting ? "正在拆解" : "AI 生成 3 步"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={suggesting}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        steps: [...current.steps, createStep("")],
                      }))
                    }
                  >
                    <Plus /> 添加
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                {draft.steps.map((step, index) => (
                  <div key={step.id} className="flex items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-indigo-50 font-mono text-xs text-indigo-700">
                      {index + 1}
                    </span>
                    <Input
                      aria-label={`步骤 ${index + 1}`}
                      maxLength={100}
                      placeholder={
                        index === 0 ? "先做哪一步？" : "下一步是什么？"
                      }
                      value={step.title}
                      disabled={suggesting}
                      onChange={(event) =>
                        updateStep(step.id, { title: event.target.value })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 sm:size-8"
                      aria-label={`删除步骤 ${index + 1}`}
                      disabled={suggesting || draft.steps.length === 1}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          steps: current.steps.filter(
                            (item) => item.id !== step.id,
                          ),
                        }))
                      }
                    >
                      <X />
                    </Button>
                  </div>
                ))}
              </div>
              {!task ? (
                <p className="text-xs leading-5 text-slate-500">
                  点击“AI 生成 3
                  步”会将任务标题和预计时长发送给阿里云百炼；不会发送摄像头画面或视觉数据。生成期间会暂时锁定表单；关闭弹窗后，返回结果不会写入任务。
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="observation-profile">任务观察方式</Label>
              <Select
                value={draft.observationProfile}
                disabled={suggesting || profileLocked}
                onValueChange={(value) => {
                  setProfileReason(null)
                  setDraft((current) => ({
                    ...current,
                    observationProfile: value as ObservationProfile,
                  }))
                }}
              >
                <SelectTrigger id="observation-profile" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {observationProfileValues.map((profile) => (
                    <SelectItem key={profile} value={profile}>
                      {observationProfiles[profile].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p
                aria-live="polite"
                className="text-xs leading-5 text-slate-500"
              >
                {profileReason ? `AI 建议：${profileReason}。` : null}
                {getObservationProfile(draft.observationProfile).description}
                {profileLocked
                  ? " 当前任务有一段未结束的学习，观察方式会保持为该 session 开始时的快照；结束本次学习后可修改。"
                  : " 你可以修改，AI 不会接收摄像头画面。"}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="priority">优先级</Label>
                <Select
                  value={draft.priority}
                  disabled={suggesting}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      priority: value as Priority,
                    }))
                  }
                >
                  <SelectTrigger id="priority" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">高优先</SelectItem>
                    <SelectItem value="medium">中优先</SelectItem>
                    <SelectItem value="low">低优先</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="estimate">预计时长（分钟）</Label>
                <Input
                  id="estimate"
                  type="number"
                  min={1}
                  max={480}
                  value={draft.estimatedMinutes}
                  disabled={suggesting}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      estimatedMinutes: Number(event.target.value),
                    }))
                  }
                />
              </div>
            </div>
          </div>

          <DialogFooter className="sticky bottom-0 z-10 mx-0 mb-0 shrink-0 rounded-none rounded-b-xl bg-slate-50/95 px-4 py-4 backdrop-blur supports-[backdrop-filter]:bg-slate-50/85 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving || suggesting}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
              {task ? "保存修改" : "创建任务"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TaskRow({
  task,
  onEdit,
  onStart,
  onComplete,
  onReopen,
  onDuplicate,
  onRestore,
  onArchive,
  onDelete,
  starting,
  statusChanging,
  sessionState,
  currentSessionStatus,
}: {
  task: Task
  onEdit: () => void
  onStart: () => void
  onComplete: () => Promise<void>
  onReopen: () => Promise<void>
  onDuplicate: () => Promise<void>
  onRestore: () => Promise<void>
  onArchive: () => Promise<void>
  onDelete: () => Promise<void>
  starting: boolean
  statusChanging: boolean
  sessionState: "current" | "blocked" | "none"
  currentSessionStatus: "running" | "paused" | null
}) {
  const [expanded, setExpanded] = useState(false)
  const sessionHistory = useTaskSessions(task.id, expanded)
  const completedSteps = task.steps.filter((step) => step.completed).length
  const progress = task.steps.length
    ? (completedSteps / task.steps.length) * 100
    : 0
  const priority = priorityMeta[task.priority]
  const displayStatus = taskDisplayStatus(task, currentSessionStatus)
  const status = statusMeta[displayStatus]
  const completed = displayStatus === "completed"
  const archived = displayStatus === "archived"
  const readyToComplete = displayStatus === "ready_to_complete"
  const nextStep = task.steps.find((step) => !step.completed)

  return (
    <Card
      className={`overflow-hidden border-indigo-100 bg-white/92 py-0 transition-[border-color,background-color] hover:border-indigo-200 ${completed ? "bg-slate-50/85" : ""}`}
    >
      <CardContent className="p-0">
        <div className="grid min-h-32 gap-x-4 gap-y-3 p-3.5 sm:min-h-24 sm:grid-cols-[auto_minmax(0,1fr)_10rem_auto] sm:items-center sm:gap-x-5 sm:py-3">
          <div className="flex items-center gap-2 sm:flex-col sm:gap-1.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-50">
              <TaskStateIcon status={displayStatus} />
            </span>
            <Badge variant="outline" className={status.className}>
              {status.label}
            </Badge>
          </div>

          <div className="min-w-0 self-center">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                className={`truncate text-base font-semibold text-slate-950 ${completed ? "text-slate-500 line-through" : ""}`}
              >
                {task.title}
              </h2>
              <Badge
                variant="outline"
                className={`hidden shrink-0 md:inline-flex ${priority.className}`}
              >
                {priority.label}
              </Badge>
            </div>
            <p className="mt-1 truncate text-sm text-slate-500">
              {readyToComplete
                ? "所有步骤已勾选，等待你确认完成"
                : nextStep
                  ? `下一步 · ${nextStep.title}`
                  : getObservationProfile(task.observation_profile).shortLabel}
            </p>
            <div className="mt-2 flex items-center gap-3 text-xs text-slate-500 sm:hidden">
              <span>
                {completedSteps}/{task.steps.length} 步
              </span>
              <span>预计 {task.estimated_minutes} 分钟</span>
            </div>
          </div>

          <div className="hidden min-w-0 sm:block">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                {completedSteps}/{task.steps.length} 步
              </span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="mt-2 h-1.5" />
            <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
              <Clock3 className="size-3.5" /> 预计 {task.estimated_minutes} 分钟
            </p>
          </div>

          <div className="col-span-full flex items-center justify-end gap-1 sm:col-span-1">
            {readyToComplete ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={statusChanging}>
                    {statusChanging ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <CheckCircle2 />
                    )}
                    确认完成
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      确认完成“{task.title}”？
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {sessionState === "current"
                        ? "这会结束当前学习记录，保存计时并将任务移到“已完成”。复盘可以稍后再做。"
                        : "任务会移到“已完成”，不会再出现“开始学习”。"}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>继续保留</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void onComplete()}>
                      确认完成
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : !completed && !archived ? (
              <Button
                size="sm"
                className="min-w-24"
                variant={sessionState === "current" ? "secondary" : "default"}
                onClick={onStart}
                disabled={
                  starting ||
                  sessionState === "blocked" ||
                  !canStartTaskNow(task)
                }
                title={
                  sessionState === "blocked"
                    ? "请先结束当前学习会话"
                    : undefined
                }
              >
                {starting ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Play />
                )}
                {sessionState === "current" ? "继续学习" : "开始学习"}
              </Button>
            ) : completed ? (
              <span className="px-2 text-sm text-slate-500">
                {task.completed_at
                  ? new Date(task.completed_at).toLocaleDateString("zh-CN")
                  : "已完成"}
              </span>
            ) : null}

            <Button
              variant="ghost"
              size="icon"
              className="size-11 sm:size-9"
              aria-label={expanded ? "收起任务详情" : "展开任务详情"}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? <ChevronUp /> : <ChevronDown />}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 sm:size-9"
                  aria-label="任务操作"
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!completed && !archived ? (
                  <DropdownMenuItem onSelect={onEdit}>
                    <Pencil /> 编辑任务
                  </DropdownMenuItem>
                ) : null}
                {completed ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <DropdownMenuItem
                        onSelect={(event) => event.preventDefault()}
                      >
                        <RotateCcw /> 重新打开任务
                      </DropdownMenuItem>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          重新打开“{task.title}”？
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          任务会回到待继续，最后一步会重新打开；既有学习和复盘记录不会被删除。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>保持已完成</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void onReopen()}>
                          重新打开
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : archived ? (
                  <DropdownMenuItem
                    disabled={statusChanging}
                    onSelect={() => void onRestore()}
                  >
                    {statusChanging ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <RotateCcw />
                    )}
                    {statusChanging ? "正在恢复…" : "恢复到任务台"}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={statusChanging}
                  onSelect={() => void onDuplicate()}
                >
                  <Copy /> 复制为新任务
                </DropdownMenuItem>
                {!completed && !archived ? (
                  <DropdownMenuItem
                    disabled={sessionState === "current" || statusChanging}
                    onSelect={() => void onArchive()}
                  >
                    <Archive />
                    {sessionState === "current"
                      ? "学习会话进行中，无法归档"
                      : "归档任务"}
                  </DropdownMenuItem>
                ) : null}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={sessionState === "current" || statusChanging}
                      onSelect={(event) => event.preventDefault()}
                    >
                      <Trash2 />
                      {sessionState === "current"
                        ? "学习会话进行中，无法删除"
                        : "删除任务"}
                    </DropdownMenuItem>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>删除“{task.title}”？</AlertDialogTitle>
                      <AlertDialogDescription>
                        任务、关联学习会话、观察事件和复盘会被永久删除，无法恢复。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>保留</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => void onDelete()}
                      >
                        永久删除
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {expanded ? (
          <div className="grid gap-5 border-t border-indigo-100 bg-slate-50/60 px-4 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(15rem,0.6fr)]">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">任务步骤</h3>
              <ol className="mt-2 grid gap-2 sm:grid-cols-2">
                {task.steps.map((step, index) => (
                  <li
                    key={step.id}
                    className="flex min-w-0 items-start gap-2 rounded-xl bg-white px-3 py-2 text-sm"
                  >
                    {step.completed ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-indigo-50 text-[10px] font-medium text-indigo-700">
                        {index + 1}
                      </span>
                    )}
                    <span
                      className={`min-w-0 break-words ${step.completed ? "text-slate-400 line-through" : "text-slate-700"}`}
                    >
                      {step.title}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                最近学习记录
              </h3>
              {sessionHistory.isLoading ? (
                <div className="mt-2 space-y-2">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : sessionHistory.isError ? (
                <div className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  学习记录暂时未读取。
                  <button
                    type="button"
                    className="ml-1 font-medium underline underline-offset-2"
                    onClick={() => void sessionHistory.refetch()}
                  >
                    重试
                  </button>
                </div>
              ) : sessionHistory.data?.length ? (
                <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
                  {sessionHistory.data.slice(0, 3).map((session) => (
                    <li
                      key={session.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2"
                    >
                      <span>
                        {session.status === "completed"
                          ? "已完成"
                          : session.status === "cancelled"
                            ? "已结束"
                            : session.status === "paused"
                              ? "已暂停"
                              : "计时中"}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatMinutes(session.accumulated_seconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-500">还没有学习记录。</p>
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function TaskDashboard() {
  const router = useRouter()
  const tasks = useTasks()
  const settings = useSettings()
  const activeSession = useActiveSession()
  const mutations = useTaskMutations()
  const sessionMutations = useSessionMutations()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null)
  const [statusChangingTaskId, setStatusChangingTaskId] = useState<
    string | null
  >(null)
  const [taskView, setTaskView] = useState<"active" | "completed" | "archived">(
    "active",
  )
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<"priority" | "newest">("priority")

  const taskGroups = useMemo(() => {
    const items: Task[] = tasks.data ?? []
    const active = items.filter((task) => canStartTask(task.status))
    const completed = items.filter((task) => task.status === "completed")
    const archived = items.filter((task) => task.status === "archived")
    return {
      active,
      completed,
      archived,
      estimated: active.reduce((sum, task) => sum + task.estimated_minutes, 0),
    }
  }, [tasks.data])

  const visibleTasks = useMemo(() => {
    const source =
      taskView === "active"
        ? taskGroups.active
        : taskView === "completed"
          ? taskGroups.completed
          : taskGroups.archived
    const query = search.trim().toLocaleLowerCase("zh-CN")
    const filtered = query
      ? source.filter(
          (task) =>
            task.title.toLocaleLowerCase("zh-CN").includes(query) ||
            task.steps.some((step) =>
              step.title.toLocaleLowerCase("zh-CN").includes(query),
            ),
        )
      : source
    const weights: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
    return [...filtered].sort((left, right) => {
      if (sort === "priority") {
        const difference = weights[left.priority] - weights[right.priority]
        if (difference !== 0) return difference
      }
      return (
        new Date(right.updated_at).getTime() -
        new Date(left.updated_at).getTime()
      )
    })
  }, [search, sort, taskGroups, taskView])

  const activeSessionTask = tasks.data?.find(
    (task) => task.id === activeSession.data?.task_id,
  )
  const activeSessionReady = Boolean(
    activeSessionTask && areTaskStepsComplete(activeSessionTask.steps),
  )

  const saveTask = async (draft: TaskDraft) => {
    try {
      if (editingTask)
        await mutations.update.mutateAsync({ taskId: editingTask.id, draft })
      else await mutations.create.mutateAsync(draft)
      toast.success(editingTask ? "任务已更新" : "任务已创建")
      setDialogOpen(false)
      setEditingTask(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败")
    }
  }

  const beginTask = async (taskId: string) => {
    const task = tasks.data?.find((item) => item.id === taskId)
    if (!task || !canStartTaskNow(task)) {
      toast.info(
        task && areTaskStepsComplete(task.steps)
          ? "全部步骤已完成，请先确认完成任务"
          : "已完成或已归档的任务不能直接开始",
      )
      return
    }
    setStartingTaskId(taskId)
    try {
      const session = await sessionMutations.start.mutateAsync({
        taskId,
        remindersEnabled: settings.data?.reminders_enabled ?? true,
        experimentMode: settings.data?.experiment_mode ?? false,
      })
      if (session.task_id !== taskId)
        toast.info("你已有一段未结束的学习，已为你继续恢复")
      router.push(`/app/session/${session.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法开始学习")
    } finally {
      setStartingTaskId(null)
    }
  }

  const changeTaskStatus = async (
    taskId: string,
    status: "planned" | "archived",
    successMessage: string,
  ) => {
    if (status === "archived" && activeSession.data?.task_id === taskId) {
      toast.info("当前学习会话结束前不能归档任务")
      return
    }
    setStatusChangingTaskId(taskId)
    try {
      await mutations.setStatus.mutateAsync({ taskId, status })
      toast.success(successMessage)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "任务状态更新失败")
    } finally {
      setStatusChangingTaskId(null)
    }
  }

  const confirmTask = async (task: Task) => {
    if (!areTaskStepsComplete(task.steps)) {
      toast.info("请先完成所有任务步骤")
      return
    }
    const linkedSession =
      activeSession.data?.task_id === task.id ? activeSession.data : null
    setStatusChangingTaskId(task.id)
    try {
      await mutations.complete.mutateAsync({
        taskId: task.id,
        accumulatedSeconds: linkedSession?.accumulated_seconds,
      })
      toast.success("任务已完成", {
        description: "已移入“已完成”，不会再重新开始。",
        action: linkedSession
          ? {
              label: "立即复盘",
              onClick: () => router.push(`/app/review/${linkedSession.id}`),
            }
          : {
              label: "查看已完成",
              onClick: () => setTaskView("completed"),
            },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认完成失败")
    } finally {
      setStatusChangingTaskId(null)
    }
  }

  const reopenTask = async (task: Task) => {
    setStatusChangingTaskId(task.id)
    try {
      await mutations.reopen.mutateAsync(task.id)
      toast.success("任务已重新打开", {
        description: "最后一步已恢复为待完成，既有记录保留不变。",
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新打开失败")
    } finally {
      setStatusChangingTaskId(null)
    }
  }

  const duplicateExistingTask = async (task: Task) => {
    setStatusChangingTaskId(task.id)
    try {
      await mutations.duplicate.mutateAsync(task)
      setTaskView("active")
      toast.success("已复制为新任务", {
        description: "新任务的所有步骤均从未完成开始。",
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "复制任务失败")
    } finally {
      setStatusChangingTaskId(null)
    }
  }

  if (tasks.isLoading) {
    return (
      <div className="space-y-5" aria-label="正在读取任务">
        <Skeleton className="h-16 w-80 max-w-full" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <div className="space-y-3">
          <Skeleton className="h-32 w-full rounded-2xl sm:h-24" />
          <Skeleton className="h-32 w-full rounded-2xl sm:h-24" />
          <Skeleton className="h-32 w-full rounded-2xl sm:h-24" />
        </div>
      </div>
    )
  }

  if (tasks.isError) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>任务暂时没有加载出来</CardTitle>
          <CardDescription>{tasks.error.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void tasks.refetch()}>重新读取</Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <section className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            今天，先完成哪一件具体的事？
          </h1>
          <p className="mt-3 text-slate-600">
            把“大任务”拆成下一步，计时才真正有方向。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void mutations.sample
                .mutateAsync()
                .then(() => toast.success("示例任务已载入"))
                .catch((error) => toast.error(error.message))
            }
            disabled={mutations.sample.isPending}
          >
            {mutations.sample.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Sparkles />
            )}{" "}
            载入示例
          </Button>
          <Button
            onClick={() => {
              setEditingTask(null)
              setDialogOpen(true)
            }}
          >
            <Plus /> 新建任务
          </Button>
        </div>
      </section>

      {activeSession.data ? (
        <Card className="mt-7 border-indigo-200 bg-indigo-700 text-white">
          <CardContent className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-white/15">
                <Play className="size-5" />
              </span>
              <div>
                <p className="font-medium">
                  {activeSessionReady
                    ? "全部步骤已完成，等待确认"
                    : "有一段学习尚未结束"}
                </p>
                <p className="text-sm text-indigo-100">
                  {activeSessionReady
                    ? "确认后会保存计时并移入已完成"
                    : `状态：${activeSession.data.status === "paused" ? "已暂停" : "计时中"}`}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                router.push(`/app/session/${activeSession.data!.id}`)
              }
            >
              {activeSessionReady ? "查看并确认" : "继续学习"} <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <section
        aria-label="任务概览"
        className="mt-7 grid grid-cols-3 divide-x divide-indigo-100 rounded-2xl border border-indigo-100 bg-white/80 px-2 py-4 sm:px-5"
      >
        {[
          {
            icon: BookOpenCheck,
            label: "待完成",
            value: taskGroups.active.length,
            unit: "个",
          },
          {
            icon: Clock3,
            label: "预计投入",
            value: taskGroups.estimated,
            unit: "分钟",
          },
          {
            icon: CheckCircle2,
            label: "已完成",
            value: taskGroups.completed.length,
            unit: "个",
          },
        ].map(({ icon: Icon, label, value, unit }) => (
          <div
            key={label}
            className="flex min-w-0 items-center justify-center gap-2 px-2 sm:gap-3 sm:px-4"
          >
            <span className="hidden size-9 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700 sm:grid">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 text-center sm:text-left">
              <p className="truncate text-xs text-slate-500 sm:text-sm">
                {label}
              </p>
              <p className="mt-0.5 font-semibold text-slate-950 tabular-nums sm:text-lg">
                {value}{" "}
                <span className="text-xs font-normal text-slate-500">
                  {unit}
                </span>
              </p>
            </div>
          </div>
        ))}
      </section>

      <section className="mt-8">
        {(tasks.data?.length ?? 0) > 0 ? (
          <>
            <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-indigo-100 bg-white/75 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex max-w-full overflow-x-auto rounded-xl bg-slate-100 p-1">
                <Button
                  size="sm"
                  variant={taskView === "active" ? "secondary" : "ghost"}
                  onClick={() => setTaskView("active")}
                >
                  待完成 {taskGroups.active.length}
                </Button>
                <Button
                  size="sm"
                  variant={taskView === "completed" ? "secondary" : "ghost"}
                  onClick={() => setTaskView("completed")}
                >
                  已完成 {taskGroups.completed.length}
                </Button>
                <Button
                  size="sm"
                  variant={taskView === "archived" ? "secondary" : "ghost"}
                  onClick={() => setTaskView("archived")}
                >
                  已归档 {taskGroups.archived.length}
                </Button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    className="w-full pl-9 sm:w-60"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索任务或步骤"
                    aria-label="搜索任务或步骤"
                  />
                </div>
                <Select
                  value={sort}
                  onValueChange={(value) =>
                    setSort(value as "priority" | "newest")
                  }
                >
                  <SelectTrigger
                    className="w-full sm:w-36"
                    aria-label="任务排序"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="priority">优先级排序</SelectItem>
                    <SelectItem value="newest">最近更新</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {visibleTasks.length ? (
              <div className="space-y-3">
                {visibleTasks.map((task: Task) => {
                  const isCurrentSession =
                    activeSession.data?.task_id === task.id
                  const sessionState = isCurrentSession
                    ? "current"
                    : activeSession.data
                      ? "blocked"
                      : "none"
                  return (
                    <TaskRow
                      key={task.id}
                      task={task}
                      starting={startingTaskId === task.id}
                      statusChanging={statusChangingTaskId === task.id}
                      sessionState={sessionState}
                      currentSessionStatus={
                        isCurrentSession &&
                        (activeSession.data?.status === "running" ||
                          activeSession.data?.status === "paused")
                          ? activeSession.data.status
                          : null
                      }
                      onEdit={() => {
                        setEditingTask(task)
                        setDialogOpen(true)
                      }}
                      onStart={() => {
                        if (isCurrentSession && activeSession.data) {
                          router.push(`/app/session/${activeSession.data.id}`)
                          return
                        }
                        void beginTask(task.id)
                      }}
                      onComplete={() => confirmTask(task)}
                      onReopen={() => reopenTask(task)}
                      onDuplicate={() => duplicateExistingTask(task)}
                      onRestore={() =>
                        changeTaskStatus(
                          task.id,
                          "planned",
                          "任务已恢复到任务台",
                        )
                      }
                      onArchive={() =>
                        changeTaskStatus(task.id, "archived", "任务已归档")
                      }
                      onDelete={async () => {
                        if (activeSession.data?.task_id === task.id) {
                          toast.info("当前学习会话结束前不能删除任务")
                          return
                        }
                        try {
                          await mutations.remove.mutateAsync(task.id)
                          toast.success("任务与关联记录已删除")
                        } catch (error) {
                          toast.error(
                            error instanceof Error ? error.message : "删除失败",
                          )
                        }
                      }}
                    />
                  )
                })}
              </div>
            ) : (
              <Card className="border-dashed border-indigo-200 bg-white/65 py-10 text-center">
                <CardContent>
                  {search ? (
                    <>
                      <Search className="mx-auto size-7 text-slate-400" />
                      <h2 className="mt-4 font-semibold text-slate-900">
                        没有找到匹配任务
                      </h2>
                      <Button
                        className="mt-4"
                        size="sm"
                        variant="outline"
                        onClick={() => setSearch("")}
                      >
                        清除搜索
                      </Button>
                    </>
                  ) : taskView === "completed" ? (
                    <>
                      <CheckCircle2 className="mx-auto size-7 text-emerald-500" />
                      <h2 className="mt-4 font-semibold text-slate-900">
                        还没有已完成任务
                      </h2>
                      <p className="mt-1 text-sm text-slate-500">
                        完成的任务会留在这里，不会再出现“开始学习”。
                      </p>
                    </>
                  ) : taskView === "archived" ? (
                    <>
                      <Archive className="mx-auto size-7 text-slate-400" />
                      <h2 className="mt-4 font-semibold text-slate-900">
                        还没有归档任务
                      </h2>
                      <p className="mt-1 text-sm text-slate-500">
                        暂时不推进的任务可以放在这里，并随时恢复。
                      </p>
                    </>
                  ) : (
                    <>
                      <ListPlus className="mx-auto size-7 text-indigo-500" />
                      <h2 className="mt-4 font-semibold text-slate-900">
                        当前没有待完成任务
                      </h2>
                      <p className="mt-1 text-sm text-slate-500">
                        {taskGroups.archived.length > 0
                          ? `${taskGroups.archived.length} 个任务已归档，可以随时恢复到任务台。`
                          : "新建一项任务，从下一个可执行步骤开始。"}
                      </p>
                      <div className="mt-4 flex justify-center gap-2">
                        {taskGroups.archived.length > 0 ? (
                          <Button
                            variant="outline"
                            onClick={() => setTaskView("archived")}
                          >
                            <Archive /> 查看已归档
                          </Button>
                        ) : null}
                        <Button
                          onClick={() => {
                            setEditingTask(null)
                            setDialogOpen(true)
                          }}
                        >
                          <Plus /> 新建任务
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <Card className="border-dashed border-indigo-200 bg-white/65 py-12 text-center">
            <CardContent>
              <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-indigo-50 text-indigo-700">
                <ListPlus className="size-7" />
              </span>
              <h2 className="mt-5 text-xl font-semibold text-slate-950">
                任务台还是空的
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
                创建自己的任务，或主动载入两条不会包含真实课程数据的示例。
              </p>
              <div className="mt-6 flex justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => mutations.sample.mutate()}
                >
                  <Sparkles /> 载入示例
                </Button>
                <Button onClick={() => setDialogOpen(true)}>
                  <Plus /> 新建任务
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {dialogOpen ? (
        <TaskDialog
          open
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) setEditingTask(null)
          }}
          task={editingTask}
          profileLocked={Boolean(
            editingTask && activeSession.data?.task_id === editingTask.id,
          )}
          onSave={saveTask}
          saving={mutations.create.isPending || mutations.update.isPending}
        />
      ) : null}
    </>
  )
}
