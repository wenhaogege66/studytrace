"use client"

import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  EyeOff,
  FilePenLine,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, type FormEvent } from "react"
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
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  useBehaviorEvents,
  useEventMutations,
  useReview,
  useReviewMutation,
  useSession,
  useTask,
} from "@/hooks/use-study-data"
import {
  formatMinutes,
  type BehaviorEvent,
  type CompletionStatus,
  type EventDirection,
  type Review,
  type SessionOutcome,
} from "@/lib/domain"

function sourceLabel(source: BehaviorEvent["source"]) {
  if (source === "vision") return "本地识别"
  if (source === "simulation") return "模拟"
  return "手动"
}

function effectiveEventLabel(event: BehaviorEvent) {
  const type =
    event.review_status === "corrected" && event.corrected_type
      ? event.corrected_type
      : event.event_type
  const direction =
    event.review_status === "corrected" && event.corrected_direction
      ? event.corrected_direction
      : event.direction
  if (type === "not_relevant") return "与本次复盘无关"
  if (type === "face_absent") return "未在画面"
  if (type === "manual") return "手动标记"
  const map: Record<string, string> = {
    left: "向左",
    right: "向右",
    down: "低头",
    unknown: "方向变化",
  }
  return `头部方向变化 · ${map[direction ?? "unknown"]}`
}

function EventCorrectionDialog({
  event,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  event: BehaviorEvent
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (input: {
    correctedType: string
    direction: EventDirection | null
    note: string
  }) => Promise<void>
  saving: boolean
}) {
  const [correctedType, setCorrectedType] = useState(
    event.corrected_type ?? event.event_type,
  )
  const [direction, setDirection] = useState<EventDirection | null>(
    (event.corrected_direction as EventDirection | null) ?? event.direction,
  )
  const [note, setNote] = useState(event.correction_note ?? "")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修正这条事件</DialogTitle>
          <DialogDescription>
            识别结果不是事实判断。请按你对当时情境的理解改写。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>事件类型</Label>
            <Select value={correctedType} onValueChange={setCorrectedType}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="face_absent">未在画面</SelectItem>
                <SelectItem value="head_direction_change">
                  头部方向变化
                </SelectItem>
                <SelectItem value="manual">手动标记</SelectItem>
                <SelectItem value="not_relevant">与本次复盘无关</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {correctedType === "head_direction_change" ? (
            <div className="space-y-2">
              <Label>方向</Label>
              <Select
                value={direction ?? "unknown"}
                onValueChange={(value) => setDirection(value as EventDirection)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">向左</SelectItem>
                  <SelectItem value="right">向右</SelectItem>
                  <SelectItem value="down">低头</SelectItem>
                  <SelectItem value="unknown">不确定</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="correction-note">修正说明（可选）</Label>
            <Textarea
              id="correction-note"
              maxLength={280}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：当时在低头查看草稿纸"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              void onSave({
                correctedType,
                direction:
                  correctedType === "head_direction_change" ? direction : null,
                note,
              })
            }
          >
            {saving ? <LoaderCircle className="animate-spin" /> : <Save />}{" "}
            保存修正
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EventItem({
  event,
  sessionId,
}: {
  event: BehaviorEvent
  sessionId: string
}) {
  const mutations = useEventMutations(sessionId)
  const [editing, setEditing] = useState(false)
  const durationSeconds = event.ended_at
    ? Math.max(
        0,
        Math.round(
          (new Date(event.ended_at).getTime() -
            new Date(event.started_at).getTime()) /
            1000,
        ),
      )
    : null

  return (
    <div className="relative grid gap-3 pl-8 sm:grid-cols-[1fr_auto] sm:items-center">
      <span
        className={`absolute top-2 left-0 size-3 rounded-full ring-4 ring-white ${event.review_status === "confirmed" ? "bg-emerald-500" : event.review_status === "corrected" ? "bg-indigo-500" : "bg-amber-500"}`}
      />
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-slate-900">
            {effectiveEventLabel(event)}
          </p>
          <Badge variant="outline">{sourceLabel(event.source)}</Badge>
          {event.review_status === "confirmed" ? (
            <Badge className="bg-emerald-100 text-emerald-800">已确认</Badge>
          ) : null}
          {event.review_status === "corrected" ? (
            <Badge className="bg-indigo-100 text-indigo-800">已修正</Badge>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {new Date(event.started_at).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
          {durationSeconds === null
            ? " · 会话结束时仍在进行"
            : ` · 持续 ${durationSeconds} 秒`}
          {event.correction_note ? ` · ${event.correction_note}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={event.review_status === "confirmed"}
          onClick={() =>
            void mutations.update
              .mutateAsync({
                eventId: event.id,
                update: {
                  review_status: "confirmed",
                  corrected_type: null,
                  corrected_direction: null,
                  correction_note: null,
                },
              })
              .then(() => toast.success("事件已确认"))
              .catch((error) => toast.error(error.message))
          }
        >
          <Check /> 确认
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          <FilePenLine /> 修正
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="永久删除事件">
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>永久删除这条事件？</AlertDialogTitle>
              <AlertDialogDescription>
                该事件及关联提醒记录会被硬删除，之后无法恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() =>
                  void mutations.remove
                    .mutateAsync(event.id)
                    .then(() => toast.success("事件已永久删除"))
                    .catch((error) => toast.error(error.message))
                }
              >
                永久删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {editing ? (
        <EventCorrectionDialog
          event={event}
          open
          onOpenChange={setEditing}
          saving={mutations.update.isPending}
          onSave={async ({ correctedType, direction, note }) => {
            try {
              await mutations.update.mutateAsync({
                eventId: event.id,
                update: {
                  review_status: "corrected",
                  corrected_type: correctedType,
                  corrected_direction: direction,
                  correction_note: note.trim() || null,
                },
              })
              setEditing(false)
              toast.success("事件修正已保存")
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : "修正保存失败",
              )
            }
          }}
        />
      ) : null}
    </div>
  )
}

function ReviewFormCard({
  sessionId,
  initialReview,
  sessionOutcome,
}: {
  sessionId: string
  initialReview: Review | null
  sessionOutcome: SessionOutcome | null
}) {
  const reviewMutation = useReviewMutation(sessionId)
  const [completionStatus, setCompletionStatus] = useState<CompletionStatus>(
    initialReview?.completion_status ?? sessionOutcome ?? "completed",
  )
  const [selfRating, setSelfRating] = useState(initialReview?.self_rating ?? 4)
  const [incompleteReason, setIncompleteReason] = useState(
    initialReview?.incomplete_reason ?? "",
  )
  const [nextAdjustment, setNextAdjustment] = useState(
    initialReview?.next_adjustment ?? "",
  )

  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await reviewMutation.mutateAsync({
        completionStatus,
        selfRating,
        incompleteReason,
        nextAdjustment,
      })
      toast.success("这次复盘已经保存")
    } catch (saveError) {
      toast.error(
        saveError instanceof Error ? saveError.message : "复盘保存失败",
      )
    }
  }

  return (
    <Card className="border-indigo-100 bg-white/90 shadow-sm">
      <form onSubmit={(event) => void save(event)}>
        <CardHeader>
          <CardTitle>写下这一次</CardTitle>
          <CardDescription>保存后仍可以回来修改。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>完成情况</Label>
            <Select
              value={completionStatus}
              onValueChange={(value) =>
                setCompletionStatus(value as CompletionStatus)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="completed">已完成</SelectItem>
                <SelectItem value="partially_completed">部分完成</SelectItem>
                <SelectItem value="not_completed">未完成</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs leading-5 text-slate-500">
              这里只描述本次学习，不会改变整个任务的完成状态。
            </p>
          </div>
          <div className="space-y-2">
            <Label>这次学习的自我感受（1–5）</Label>
            <div className="grid grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map((rating) => (
                <Button
                  key={rating}
                  type="button"
                  variant={selfRating === rating ? "default" : "outline"}
                  onClick={() => setSelfRating(rating)}
                  aria-label={`自评 ${rating} 分`}
                >
                  {rating}
                </Button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              这是主观记录，不是算法分数。
            </p>
          </div>
          {completionStatus !== "completed" ? (
            <div className="space-y-2">
              <Label htmlFor="incomplete-reason">没有完全完成的原因</Label>
              <Textarea
                id="incomplete-reason"
                maxLength={500}
                value={incompleteReason}
                onChange={(event) => setIncompleteReason(event.target.value)}
                placeholder="例如：前两步比预计更耗时"
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="next-adjustment">下一次只调整一件事</Label>
            <Textarea
              id="next-adjustment"
              maxLength={500}
              value={nextAdjustment}
              onChange={(event) => setNextAdjustment(event.target.value)}
              placeholder="例如：开始前先把资料放在桌面左侧"
            />
          </div>
          <Separator />
          <div className="rounded-xl bg-indigo-50 p-4 text-sm leading-6 text-indigo-950">
            <strong>提示：</strong>
            事件总数不会被转换成专注分，也不会用于能力或医学判断。
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={reviewMutation.isPending}
          >
            {reviewMutation.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Save />
            )}{" "}
            保存本次复盘
          </Button>
          {initialReview ? (
            <p className="text-center text-xs text-slate-500">
              上次保存：
              {new Date(initialReview.updated_at).toLocaleString("zh-CN")}
            </p>
          ) : null}
        </CardContent>
      </form>
    </Card>
  )
}

export function ReviewScreen({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const session = useSession(sessionId)
  const task = useTask(session.data?.task_id)
  const events = useBehaviorEvents(sessionId)
  const existingReview = useReview(sessionId)
  const sessionStatus = session.data?.status

  useEffect(() => {
    if (sessionStatus === "running" || sessionStatus === "paused")
      router.replace(`/app/session/${sessionId}`)
  }, [router, sessionId, sessionStatus])

  const eventStats = useMemo(() => {
    const list: BehaviorEvent[] = events.data ?? []
    return {
      total: list.length,
      confirmed: list.filter((event) => event.review_status !== "pending")
        .length,
      vision: list.filter((event) => event.source === "vision").length,
    }
  }, [events.data])

  if (
    session.isLoading ||
    (session.data && task.isLoading) ||
    existingReview.isLoading
  ) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20" />
        <div className="grid gap-5 md:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  if (session.isError || task.isError) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>复盘没有加载出来</CardTitle>
          <CardDescription>
            {session.error?.message ?? task.error?.message}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void session.refetch()}>
            <RotateCcw /> 重试
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!session.data || !task.data) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>没有找到这次学习</CardTitle>
          <CardDescription>记录可能已被清除。</CardDescription>
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

  if (session.data.status === "running" || session.data.status === "paused")
    return <Skeleton className="h-80 w-full" />

  return (
    <>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <Button variant="ghost" size="sm" className="mb-2 -ml-2" asChild>
            <Link href="/app">
              <ArrowLeft /> 返回任务台
            </Link>
          </Button>
          <p className="section-kicker">One-session review / 单次复盘</p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
            {task.data.title}
          </h1>
          <p className="mt-2 text-slate-600">
            不评价“好不好”，只找到下一次可操作的调整。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={
              session.data.task_outcome === "completed"
                ? "bg-emerald-100 text-emerald-800"
                : "bg-indigo-100 text-indigo-800"
            }
          >
            {session.data.task_outcome === "completed"
              ? "整个任务已完成"
              : "任务将继续推进"}
          </Badge>
          {existingReview.data ? (
            <Badge className="bg-emerald-100 text-emerald-800">
              <CheckCircle2 /> 已保存复盘
            </Badge>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link href="/app">稍后复盘</Link>
            </Button>
          )}
        </div>
      </div>

      <section className="mt-7 grid gap-4 sm:grid-cols-3">
        <Card className="border-indigo-100 bg-white/90">
          <CardContent className="flex items-center gap-4 p-5">
            <span className="grid size-11 place-items-center rounded-2xl bg-indigo-50 text-indigo-700">
              <Clock3 className="size-5" />
            </span>
            <div>
              <p className="text-sm text-slate-500">预计 / 实际</p>
              <p className="mt-1 font-semibold text-slate-950">
                {task.data.estimated_minutes} 分钟 /{" "}
                {formatMinutes(session.data.accumulated_seconds)}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-indigo-100 bg-white/90">
          <CardContent className="flex items-center gap-4 p-5">
            <span className="grid size-11 place-items-center rounded-2xl bg-amber-50 text-amber-700">
              <Sparkles className="size-5" />
            </span>
            <div>
              <p className="text-sm text-slate-500">结构化事件</p>
              <p className="mt-1 font-semibold text-slate-950">
                {eventStats.total} 条 · {eventStats.confirmed} 条已处理
              </p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-indigo-100 bg-white/90">
          <CardContent className="flex items-center gap-4 p-5">
            <span className="grid size-11 place-items-center rounded-2xl bg-emerald-50 text-emerald-700">
              <ShieldCheck className="size-5" />
            </span>
            <div>
              <p className="text-sm text-slate-500">原始媒体</p>
              <p className="mt-1 font-semibold text-slate-950">0 条保存</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <Card className="border-indigo-100 bg-white/90 shadow-sm">
          <CardHeader>
            <CardTitle>行为事件时间线</CardTitle>
            <CardDescription>
              逐条确认、改写或硬删除。模拟事件始终有来源标记。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {events.isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : null}
            {!events.isLoading && !events.data?.length ? (
              <div className="rounded-2xl border border-dashed p-8 text-center">
                <EyeOff className="mx-auto size-7 text-slate-400" />
                <p className="mt-3 font-medium text-slate-800">
                  本次没有视觉或手动事件
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  这不影响复盘，你仍可以根据完成情况和时长做调整。
                </p>
              </div>
            ) : null}
            <div className="space-y-5 border-l border-indigo-100 pl-4">
              {events.data?.map((item: BehaviorEvent) => (
                <EventItem key={item.id} event={item} sessionId={sessionId} />
              ))}
            </div>
          </CardContent>
        </Card>

        <ReviewFormCard
          key={existingReview.data?.updated_at ?? "new-review"}
          sessionId={sessionId}
          initialReview={existingReview.data ?? null}
          sessionOutcome={session.data.task_outcome}
        />
      </div>

      <div className="mt-6 flex justify-center">
        <Button variant="outline" asChild>
          <Link href="/app">
            <ArrowLeft /> 回到任务台
          </Link>
        </Button>
      </div>
    </>
  )
}
