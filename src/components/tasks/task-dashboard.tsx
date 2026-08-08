"use client"

import {
  ArrowRight,
  BookOpenCheck,
  Check,
  Clock3,
  Ellipsis,
  FilePlus2,
  ListPlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useMemo, useState, type FormEvent } from "react"
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
  useTaskMutations,
  useTasks,
} from "@/hooks/use-study-data"
import {
  createStep,
  type Priority,
  type Task,
  type TaskDraft,
  type TaskStep,
} from "@/lib/domain"

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

function emptyDraft(): TaskDraft {
  return {
    title: "",
    steps: [createStep("")],
    priority: "medium",
    estimatedMinutes: 30,
  }
}

function TaskDialog({
  open,
  onOpenChange,
  task,
  onSave,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task | null
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
        }
      : emptyDraft(),
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
    await onSave({ ...draft, title: draft.title.trim(), steps: cleanSteps })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{task ? "编辑任务" : "创建一项具体任务"}</DialogTitle>
            <DialogDescription>
              标题说明要完成什么，步骤说明真正从哪里开始。
            </DialogDescription>
          </DialogHeader>

          <div className="mt-6 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="task-title">任务标题</Label>
              <Input
                id="task-title"
                autoFocus
                maxLength={120}
                placeholder="例如：完成光合作用实验复盘"
                value={draft.title}
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      steps: [...current.steps, createStep("")],
                    }))
                  }
                >
                  <Plus /> 添加步骤
                </Button>
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
                      onChange={(event) =>
                        updateStep(step.id, { title: event.target.value })
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`删除步骤 ${index + 1}`}
                      disabled={draft.steps.length === 1}
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
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="priority">优先级</Label>
                <Select
                  value={draft.priority}
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

          <DialogFooter className="mt-7">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
              {task ? "保存修改" : "创建任务"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function TaskCard({
  task,
  onEdit,
  onStart,
  onDelete,
  starting,
}: {
  task: Task
  onEdit: () => void
  onStart: () => void
  onDelete: () => Promise<void>
  starting: boolean
}) {
  const completedSteps = task.steps.filter((step) => step.completed).length
  const progress = task.steps.length
    ? (completedSteps / task.steps.length) * 100
    : 0
  const priority = priorityMeta[task.priority]

  return (
    <Card className="group border-indigo-100 bg-white/90 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-950/5">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={priority.className}>
                {priority.label}
              </Badge>
              {task.status === "in_progress" ? (
                <Badge variant="secondary">进行过</Badge>
              ) : null}
            </div>
            <CardTitle className="line-clamp-2 text-xl leading-7">
              {task.title}
            </CardTitle>
            <CardDescription className="mt-2 flex items-center gap-1.5">
              <Clock3 className="size-3.5" /> 预计 {task.estimated_minutes} 分钟
            </CardDescription>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="任务操作">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil /> 编辑任务
              </DropdownMenuItem>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(event) => event.preventDefault()}
                  >
                    <Trash2 /> 删除任务
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
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-slate-500">
            <span>
              {completedSteps} / {task.steps.length} 步
            </span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} />
        </div>
        <ol className="mt-5 space-y-2">
          {task.steps.slice(0, 3).map((step, index) => (
            <li
              key={step.id}
              className="flex items-start gap-2 text-sm text-slate-600"
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-slate-100 font-mono text-[10px] text-slate-500">
                {index + 1}
              </span>
              <span className="line-clamp-1">{step.title}</span>
            </li>
          ))}
        </ol>
        <Button className="mt-6 w-full" onClick={onStart} disabled={starting}>
          {starting ? <LoaderCircle className="animate-spin" /> : <Play />}{" "}
          开始学习
        </Button>
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

  const stats = useMemo(() => {
    const items: Task[] = tasks.data ?? []
    return {
      total: items.length,
      estimated: items.reduce((sum, task) => sum + task.estimated_minutes, 0),
      high: items.filter((task) => task.priority === "high").length,
    }
  }, [tasks.data])

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

  if (tasks.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-80 max-w-full" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
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
          <p className="section-kicker">Task desk / 学习任务台</p>
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
        <Card className="mt-7 border-indigo-200 bg-indigo-700 text-white shadow-lg shadow-indigo-950/10">
          <CardContent className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-white/15">
                <Play className="size-5" />
              </span>
              <div>
                <p className="font-medium">有一段学习尚未结束</p>
                <p className="text-sm text-indigo-100">
                  状态：
                  {activeSession.data.status === "paused" ? "已暂停" : "计时中"}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={() =>
                router.push(`/app/session/${activeSession.data!.id}`)
              }
            >
              继续学习 <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <section className="mt-7 grid gap-4 sm:grid-cols-3">
        {[
          {
            icon: BookOpenCheck,
            label: "任务总数",
            value: stats.total,
            unit: "个",
          },
          {
            icon: Clock3,
            label: "预计投入",
            value: stats.estimated,
            unit: "分钟",
          },
          { icon: FilePlus2, label: "高优先", value: stats.high, unit: "个" },
        ].map(({ icon: Icon, label, value, unit }) => (
          <Card key={label} className="border-indigo-100 bg-white/80 shadow-sm">
            <CardContent className="flex items-center gap-4 p-5">
              <span className="grid size-11 place-items-center rounded-2xl bg-indigo-50 text-indigo-700">
                <Icon className="size-5" />
              </span>
              <div>
                <p className="text-sm text-slate-500">{label}</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">
                  {value}{" "}
                  <span className="text-sm font-normal text-slate-500">
                    {unit}
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-8">
        {(tasks.data?.length ?? 0) > 0 ? (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {tasks.data!.map((task: Task) => (
              <TaskCard
                key={task.id}
                task={task}
                starting={startingTaskId === task.id}
                onEdit={() => {
                  setEditingTask(task)
                  setDialogOpen(true)
                }}
                onStart={() => void beginTask(task.id)}
                onDelete={async () => {
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
            ))}
          </div>
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
          onSave={saveTask}
          saving={mutations.create.isPending || mutations.update.isPending}
        />
      ) : null}
    </>
  )
}
