"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  Plus,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { useExperience } from "@/components/experience/experience-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { studyKeys, useActiveSession, useTask } from "@/hooks/use-study-data"
import type { Task } from "@/lib/domain"
import {
  learningPlanSchema,
  needsFirstReview,
  planChanges,
  planningReviewSchema,
  planningTemplates,
  preparePlanningResponseSchema,
  setPlanningAnswer,
  visibleQuestions,
  type LearningPlan,
  type PlanningQuestion,
  type PlanningReview,
  type PlanRevisionInput,
} from "@/lib/planning/contract"
import { manualLearningPlan } from "@/lib/planning/manual"
import {
  getAdoptedPlan,
  planFromTask,
  saveLearningPlan,
} from "@/lib/planning/repository"
import { getSupabase } from "@/lib/supabase/client"
import {
  agreementForProfile,
  type ObservationAgreement,
} from "@/lib/vision/agreement"
import {
  observationProfiles,
  observationProfileValues,
} from "@/lib/vision/profiles"

type Phase = "intent" | "questions" | "plan" | "review" | "agreement"
type DraftState = {
  phase: Phase
  intent: string
  minutes: number
  round: number
  questions: PlanningQuestion[]
  answers: Record<string, string>
  initial: LearningPlan | null
  plan: LearningPlan | null
  reviewUsed: boolean
  review: PlanningReview | null
  reviewedPlan: LearningPlan | null
  reason: string
  manual: boolean
  requestId: string
}
const storageKey = "studytrace:planning-draft:v1"
const subscribe = () => () => undefined

function initialDraft(task?: Task | null, snapshot?: unknown): DraftState {
  const plan = task ? planFromTask(task, snapshot) : null
  return {
    phase: plan ? "plan" : "intent",
    intent: plan?.intent || "",
    minutes: plan?.sessionMinutes || 25,
    round: 0,
    questions: [],
    answers: {},
    initial: plan,
    plan,
    reviewUsed: false,
    review: null,
    reviewedPlan: null,
    reason: "",
    manual: !!task,
    requestId: crypto.randomUUID(),
  }
}

function readDraft(
  userId: string,
  task?: Task | null,
  snapshot?: unknown,
): DraftState {
  const fallback = initialDraft(task, snapshot)
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw) return fallback
    const saved = JSON.parse(raw)
    if (saved.userId !== userId) {
      sessionStorage.removeItem(storageKey)
      return fallback
    }
    if ((saved.taskId || null) !== (task?.id || null)) return fallback
    if (
      (saved.baseRevisionId || null) !==
      (task?.current_plan_revision_id || null)
    )
      return fallback
    const state = saved.state as DraftState
    if (state.plan && !learningPlanSchema.safeParse(state.plan).success)
      return fallback
    if (state.initial && !learningPlanSchema.safeParse(state.initial).success)
      return fallback
    if (
      !["intent", "questions", "plan", "review", "agreement"].includes(
        state.phase,
      )
    )
      return fallback
    return { ...fallback, ...state }
  } catch {
    return fallback
  }
}

async function planningRequest(
  path: string,
  input: unknown,
  signal: AbortSignal,
) {
  const { data } = await getSupabase().auth.getSession()
  if (!data.session) throw new Error("使用状态已失效，请重新进入")
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(input),
    signal,
  })
  const result: unknown = await response.json()
  if (!response.ok)
    throw new Error(
      result && typeof result === "object" && "error" in result
        ? String(result.error)
        : "AI 暂时无法响应",
    )
  return result
}

export function PlanningScreen({ taskId }: { taskId?: string }) {
  const { user } = useExperience()
  const task = useTask(taskId)
  const adopted = useQuery({
    queryKey: ["adopted-plan", user?.id, task.data?.current_plan_revision_id],
    queryFn: () =>
      getAdoptedPlan(user!.id, task.data!.current_plan_revision_id!),
    enabled: !!user && !!task.data?.current_plan_revision_id,
  })
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
  if (
    !user ||
    !hydrated ||
    (taskId && task.isLoading) ||
    (!!task.data?.current_plan_revision_id && adopted.isPending)
  )
    return (
      <p role="status" className="py-16 text-center text-slate-500">
        正在准备学习计划…
      </p>
    )
  if (taskId && !task.data)
    return (
      <p role="alert">
        没有找到这个学习计划。
        <Link href="/app" className="underline">
          返回学习计划
        </Link>
      </p>
    )
  if (adopted.isError) return <p role="alert">{adopted.error.message}</p>
  return (
    <Planner
      key={`${user.id}:${taskId || "new"}`}
      userId={user.id}
      task={task.data}
      snapshot={adopted.data}
    />
  )
}

function Planner({
  userId,
  task,
  snapshot,
}: {
  userId: string
  task?: Task | null
  snapshot?: unknown
}) {
  const [state, setState] = useState<DraftState>(() =>
    readDraft(userId, task, snapshot),
  )
  const baseRevisionRef = useRef(task?.current_plan_revision_id || null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const savedRef = useRef(false)
  const router = useRouter()
  const queryClient = useQueryClient()
  const active = useActiveSession()
  const locked = !!task && active.data?.task_id === task.id
  const plan = state.plan
  const update = (patch: Partial<DraftState>) =>
    setState((current) => ({
      ...current,
      ...patch,
      requestId:
        "plan" in patch || "review" in patch || "reason" in patch
          ? crypto.randomUUID()
          : current.requestId,
    }))
  const updatePlan = (patch: Partial<LearningPlan>) =>
    setState((current) => ({
      ...current,
      plan: current.plan ? { ...current.plan, ...patch } : null,
      requestId: crypto.randomUUID(),
    }))
  const updateIntent = (intent: string) =>
    update({
      intent,
      answers: {},
      questions: [],
      round: 0,
      initial: null,
      plan: null,
      review: null,
      reviewedPlan: null,
      reviewUsed: false,
      manual: false,
    })

  useEffect(() => {
    if (!savedRef.current) {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            userId,
            taskId: task?.id || null,
            baseRevisionId: baseRevisionRef.current,
            state,
          }),
        )
      } catch {
        /* Private browsing may disable storage; editing remains available. */
      }
    }
  }, [state, userId, task?.id])
  useEffect(() => {
    mountedRef.current = true
    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
      if (session?.user.id !== userId) {
        mountedRef.current = false
        abortRef.current?.abort()
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* No persistent draft. */
        }
      }
    })
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      data.subscription.unsubscribe()
    }
  }, [userId])

  const prepare = async (forceGenerate = false) => {
    if (!state.intent.trim() || busy) return
    setBusy(true)
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = preparePlanningResponseSchema.parse(
        await planningRequest(
          "/api/planning/prepare",
          {
            intent: state.intent,
            availableMinutes: state.minutes,
            answers: state.answers,
            round: state.round,
            forceGenerate,
          },
          controller.signal,
        ),
      )
      if (!mountedRef.current || controller.signal.aborted) return
      if (result.kind === "questions")
        update({
          phase: "questions",
          questions: result.questions,
          round: state.round + 1,
        })
      else
        update({
          phase: "plan",
          initial: result.plan,
          plan: result.plan,
          reviewUsed: false,
          review: null,
          manual: false,
        })
    } catch (cause) {
      if (!controller.signal.aborted && mountedRef.current)
        setError(cause instanceof Error ? cause.message : "暂时无法生成方案")
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const confirmPlan = async () => {
    if (!plan || !state.initial || busy) return
    const valid = learningPlanSchema.safeParse(plan)
    if (!valid.success) {
      setError("请检查标题、执行步骤、完成标准和投入时长，不能留空或超出范围")
      return
    }
    if (
      state.manual ||
      !needsFirstReview(state.initial, plan, state.reviewUsed)
    ) {
      update({ phase: "agreement" })
      return
    }
    update({ reviewUsed: true, reviewedPlan: plan })
    setBusy(true)
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const review = planningReviewSchema.parse(
        await planningRequest(
          "/api/planning/review",
          { initial: state.initial, current: plan, reason: state.reason },
          controller.signal,
        ),
      )
      if (!mountedRef.current || controller.signal.aborted) return
      update({ review, phase: "review" })
    } catch (cause) {
      if (!controller.signal.aborted && mountedRef.current) {
        setError(cause instanceof Error ? cause.message : "点评暂时不可用")
        update({ phase: "agreement" })
      }
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const save = async () => {
    if (!plan || !state.initial || busy || locked) return
    const changes = planChanges(state.initial, plan)
    const revisions: PlanRevisionInput[] = [
      {
        kind: state.manual ? "manual" : "ai_initial",
        snapshot: state.initial,
        changes: [],
      },
    ]
    if (changes.length)
      revisions.push({
        kind: "user_edit",
        snapshot: state.reviewedPlan || plan,
        changes: planChanges(state.initial, state.reviewedPlan || plan),
        comment: state.reason,
      })
    if (state.review)
      revisions.push({
        kind: "ai_review",
        snapshot: state.review.suggestion || plan,
        changes: state.review.suggestion
          ? planChanges(state.initial, state.review.suggestion)
          : [],
        comment: `${state.review.comment}\n${state.review.reason}`,
      })
    setBusy(true)
    setError(null)
    try {
      const result = await saveLearningPlan({
        userId,
        requestId: state.requestId,
        taskId: task?.id,
        expectedRevisionId: baseRevisionRef.current,
        plan,
        revisions,
      })
      if (!mountedRef.current) return
      savedRef.current = true
      sessionStorage.removeItem(storageKey)
      await queryClient.invalidateQueries({ queryKey: studyKeys.tasks(userId) })
      queryClient.setQueryData(studyKeys.task(userId, result.id), result)
      toast.success(task ? "学习计划已调整，历史版本已保留" : "学习计划已制定")
      router.push("/app")
    } catch (cause) {
      if (mountedRef.current)
        setError(cause instanceof Error ? cause.message : "保存失败，请重试")
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  const phaseNumber =
    state.phase === "intent" || state.phase === "questions"
      ? 1
      : state.phase === "agreement"
        ? 3
        : 2
  return (
    <div className="mx-auto max-w-4xl pb-12 [&_button]:min-h-11 [&_input:not([type=radio]):not([type=checkbox])]:min-h-11">
      <Link
        href="/app"
        className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 hover:text-indigo-700"
      >
        <ArrowLeft className="size-4" />
        学习计划
      </Link>
      <header className="mt-5 border-b border-indigo-100 pb-6">
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          {state.phase === "intent"
            ? "想推进什么？先从一句话开始。"
            : state.phase === "questions"
              ? "补充一点，让方案更适合你。"
              : state.phase === "agreement"
                ? "确认观察约定。"
                : state.phase === "review"
                  ? "看一眼调整，再由你做决定。"
                  : "把推荐，变成自己的学习计划。"}
        </h1>
        <ol className="mt-5 flex gap-5 text-sm" aria-label="制定计划进度">
          {["表达意图", "确认方案", "观察约定"].map((label, index) => (
            <li
              key={label}
              aria-current={phaseNumber === index + 1 ? "step" : undefined}
              className={
                phaseNumber === index + 1
                  ? "font-semibold text-indigo-700"
                  : "text-slate-500"
              }
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
      </header>
      {locked ? (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          当前计划有未结束的学习。请先结束本次学习，再修改结构；暂停仍属于活动学习。
        </p>
      ) : null}
      <fieldset
        disabled={busy || locked}
        className="mt-8 min-w-0 space-y-8 disabled:opacity-70"
      >
        {state.phase === "intent" ? (
          <>
            <div className="space-y-3">
              <Label htmlFor="learning-intent">学习意图</Label>
              <Textarea
                id="learning-intent"
                autoFocus
                value={state.intent}
                maxLength={500}
                rows={4}
                placeholder="例如：我想复习高一数学函数，为下周测验做准备"
                onChange={(event) => updateIntent(event.target.value)}
              />
              <p className="text-sm text-slate-500">
                具体一点可以直接生成；还没想清楚，也可以边选边补充。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {planningTemplates.map((template) => (
                <Button
                  key={template.id}
                  variant="outline"
                  className="min-h-11"
                  onClick={() => updateIntent(template.intent)}
                >
                  {template.label}
                </Button>
              ))}
            </div>
            <div className="max-w-xs space-y-2">
              <Label htmlFor="available-minutes">
                这次大约有多少时间？（分钟，可调整）
              </Label>
              <Input
                id="available-minutes"
                type="number"
                min={1}
                max={180}
                value={state.minutes}
                onChange={(event) =>
                  update({ minutes: Number(event.target.value) })
                }
              />
            </div>
            <p className="max-w-2xl text-xs leading-6 text-slate-500">
              生成推荐时，会将你填写的意图与选项发送至阿里云百炼。不要填写个人敏感信息；不会发送摄像头画面。没有
              AI 时，仍可手动制定计划。
            </p>
          </>
        ) : null}

        {state.phase === "questions" ? (
          <>
            <p className="text-sm leading-6 text-slate-600">
              第 {state.round}{" "}
              组，最多两组。只回答与当前学习相关的问题；材料或单元选项是建议，不是完整课程目录。
            </p>
            {visibleQuestions(state.questions, state.answers)
              .slice(0, 3)
              .map((question) => (
                <fieldset key={question.id} className="space-y-3">
                  <legend className="mb-3 text-base font-medium text-slate-900">
                    {question.prompt}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {Array.from(
                      new Map(
                        [
                          ...question.options,
                          { value: "不确定", label: "不确定" },
                          { value: "跳过", label: "跳过" },
                        ].map((option) => [option.value, option] as const),
                      ).values(),
                    ).map((option) => (
                      <Button
                        type="button"
                        key={option.value}
                        variant={
                          state.answers[question.id] === option.value
                            ? "default"
                            : "outline"
                        }
                        aria-pressed={
                          state.answers[question.id] === option.value
                        }
                        className="h-auto min-h-11 max-w-full text-left whitespace-normal"
                        onClick={() =>
                          update({
                            answers: setPlanningAnswer(
                              state.questions,
                              state.answers,
                              question.id,
                              option.value,
                            ),
                          })
                        }
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  <Input
                    aria-label={`${question.prompt} 自定义回答`}
                    maxLength={300}
                    placeholder="也可以自己补充"
                    value={
                      question.options.some(
                        (option) => option.value === state.answers[question.id],
                      ) ||
                      ["跳过", "不确定"].includes(state.answers[question.id])
                        ? ""
                        : state.answers[question.id] || ""
                    }
                    onChange={(event) =>
                      update({
                        answers: setPlanningAnswer(
                          state.questions,
                          state.answers,
                          question.id,
                          event.target.value,
                        ),
                      })
                    }
                  />
                </fieldset>
              ))}
          </>
        ) : null}

        {state.phase === "plan" && plan ? (
          <>
            <div className="grid gap-6 sm:grid-cols-[1fr_12rem]">
              <div className="space-y-2">
                <Label htmlFor="plan-title">学习计划名称</Label>
                <Input
                  id="plan-title"
                  value={plan.title}
                  maxLength={120}
                  onChange={(event) =>
                    updatePlan({ title: event.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan-priority">优先级</Label>
                <select
                  id="plan-priority"
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                  value={plan.priority}
                  onChange={(event) =>
                    updatePlan({
                      priority: event.target.value as LearningPlan["priority"],
                    })
                  }
                >
                  <option value="low">低优先</option>
                  <option value="medium">中优先</option>
                  <option value="high">高优先</option>
                </select>
              </div>
            </div>
            <section className="space-y-3">
              <h2 className="font-semibold text-slate-950">为了什么而学？</h2>
              <div className="flex flex-wrap gap-2">
                {plan.purposeOptions.map((purpose) => (
                  <Button
                    key={purpose}
                    variant={plan.purpose === purpose ? "default" : "outline"}
                    aria-pressed={plan.purpose === purpose}
                    className="h-auto min-h-11 max-w-full text-left whitespace-normal"
                    onClick={() =>
                      updatePlan({
                        purpose: plan.purpose === purpose ? "" : purpose,
                      })
                    }
                  >
                    {purpose}
                  </Button>
                ))}
              </div>
              <Input
                aria-label="学习目的，可选"
                value={plan.purpose}
                maxLength={300}
                placeholder="可以选一个、自己补充，也可以不填"
                onChange={(event) =>
                  updatePlan({ purpose: event.target.value })
                }
              />
            </section>
            <section className="space-y-3">
              <h2 className="font-semibold text-slate-950">
                做到什么，才算这份计划完成？
              </h2>
              <div className="space-y-2">
                {plan.completionCriteria.map((criterion, index) => (
                  <label
                    key={index}
                    className={`flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm leading-6 ${plan.selectedCriterion === criterion ? "border-indigo-300 bg-indigo-50/60 text-indigo-950" : "border-slate-200 bg-white"}`}
                  >
                    <input
                      type="radio"
                      name="criterion"
                      className="mt-1 size-4 accent-indigo-700"
                      checked={plan.selectedCriterion === criterion}
                      onChange={() =>
                        updatePlan({ selectedCriterion: criterion })
                      }
                    />
                    {criterion}
                  </label>
                ))}
              </div>
              <Input
                aria-label="采用的完成标准"
                maxLength={300}
                value={plan.selectedCriterion}
                onChange={(event) =>
                  updatePlan({ selectedCriterion: event.target.value })
                }
              />
              <p className="text-xs text-slate-500">
                系统只记录步骤，是否达到完成标准由你确认。
              </p>
            </section>
            <section className="space-y-3">
              <Label htmlFor="plan-method">采用的方法</Label>
              <Textarea
                id="plan-method"
                value={plan.method}
                maxLength={500}
                onChange={(event) => updatePlan({ method: event.target.value })}
              />
              <p className="text-sm leading-6 text-slate-500">
                推荐理由：{plan.methodReason || "请结合自己的材料与目的调整。"}
              </p>
            </section>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-slate-950">执行步骤</h2>
                <span className="text-xs text-slate-500">已完成步骤会保留</span>
              </div>
              <ol className="space-y-2">
                {plan.steps.map((step, index) => (
                  <li key={step.id} className="flex items-center gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-indigo-50 text-sm text-indigo-700">
                      {step.completed ? (
                        <Check className="size-4" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <Textarea
                      aria-label={`执行步骤 ${index + 1}`}
                      rows={1}
                      className="min-h-11 resize-none bg-white"
                      disabled={step.completed}
                      value={step.title}
                      maxLength={120}
                      onChange={(event) =>
                        updatePlan({
                          steps: plan.steps.map((item) =>
                            item.id === step.id
                              ? { ...item, title: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0"
                      disabled={step.completed || plan.steps.length <= 1}
                      aria-label={`删除步骤 ${index + 1}`}
                      onClick={() =>
                        updatePlan({
                          steps: plan.steps.filter(
                            (item) => item.id !== step.id,
                          ),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ol>
              <Button
                variant="outline"
                disabled={plan.steps.length >= 20}
                className="min-h-11"
                onClick={() =>
                  updatePlan({
                    steps: [
                      ...plan.steps,
                      { id: crypto.randomUUID(), title: "", completed: false },
                    ],
                  })
                }
              >
                <Plus />
                添加执行步骤
              </Button>
            </section>
            <div className="grid gap-5 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="total-minutes">整个计划预计（分钟）</Label>
                <Input
                  id="total-minutes"
                  type="number"
                  min={1}
                  max={480}
                  value={plan.estimatedMinutes}
                  onChange={(event) =>
                    updatePlan({ estimatedMinutes: Number(event.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="session-minutes">本次建议（分钟）</Label>
                <Input
                  id="session-minutes"
                  type="number"
                  min={1}
                  max={180}
                  value={plan.sessionMinutes}
                  onChange={(event) =>
                    updatePlan({ sessionMinutes: Number(event.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="due-date">截止日期（可选）</Label>
                <Input
                  id="due-date"
                  type="date"
                  value={
                    plan.dueAt
                      ? new Date(plan.dueAt).toLocaleDateString("en-CA")
                      : ""
                  }
                  onChange={(event) =>
                    updatePlan({
                      dueAt: event.target.value
                        ? new Date(
                            `${event.target.value}T23:59:59`,
                          ).toISOString()
                        : null,
                    })
                  }
                />
              </div>
            </div>
            {state.initial && planChanges(state.initial, plan).length ? (
              <div className="space-y-2">
                <Label htmlFor="change-reason">为什么这样调整？（可选）</Label>
                <Input
                  id="change-reason"
                  maxLength={300}
                  value={state.reason}
                  onChange={(event) => update({ reason: event.target.value })}
                />
                <p className="text-xs text-slate-500">
                  {state.manual
                    ? "保存时会保留调整记录。"
                    : state.reviewUsed
                      ? "已完成一次修改点评，之后不再自动复核。"
                      : "确认修改后，AI 会统一点评一次；最终仍由你决定。"}
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        {state.phase === "review" && state.review ? (
          <section className="space-y-5">
            <div className="border-l border-indigo-500 pl-5">
              <h2 className="font-semibold text-slate-950">一次修改点评</h2>
              <p className="mt-3 text-base leading-7 whitespace-pre-wrap text-slate-700">
                {state.review.comment}
              </p>
              <p className="mt-3 text-sm leading-6 text-slate-500">
                {state.review.reason}
              </p>
            </div>
            {state.review.suggestion ? (
              <div className="rounded-xl border border-indigo-100 bg-white p-5">
                <h3 className="font-medium">可选修订</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {state.review.suggestion.method}
                </p>
                <ol className="mt-3 space-y-2 text-sm">
                  {state.review.suggestion.steps.map((step, index) => (
                    <li key={step.id}>
                      {index + 1}. {step.title}
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-slate-500">
                  整个计划 {state.review.suggestion.estimatedMinutes} 分钟 ·
                  本次 {state.review.suggestion.sessionMinutes} 分钟
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                无需额外修订，可以继续使用你的方案。
              </p>
            )}
          </section>
        ) : null}

        {state.phase === "agreement" && plan ? (
          <AgreementEditor plan={plan} onChange={updatePlan} />
        ) : null}
      </fieldset>
      {error ? (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"
        >
          {error}
        </p>
      ) : null}
      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-indigo-100 pt-5">
        <div>
          {state.phase !== "intent" ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                update({
                  phase:
                    state.phase === "agreement" || state.phase === "review"
                      ? "plan"
                      : "intent",
                })
              }}
            >
              <ArrowLeft />
              返回修改
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={busy || !state.intent.trim()}
              onClick={() => {
                setError(null)
                const manual = manualLearningPlan(
                  state.intent,
                  state.minutes,
                  state.answers,
                )
                update({
                  phase: "plan",
                  initial: manual,
                  plan: manual,
                  manual: true,
                })
              }}
            >
              手动制定
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {state.phase === "questions" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void prepare(true)}
            >
              按现有信息生成
            </Button>
          ) : null}
          {state.phase === "review" ? (
            <>
              <Button
                variant="outline"
                onClick={() => update({ phase: "agreement" })}
              >
                保留我的方案
              </Button>
              {state.review?.suggestion ? (
                <Button
                  onClick={() =>
                    update({ plan: state.review!.suggestion, phase: "plan" })
                  }
                >
                  采用修订，查看方案
                </Button>
              ) : (
                <Button onClick={() => update({ phase: "agreement" })}>
                  继续
                  <ArrowRight />
                </Button>
              )}
            </>
          ) : (
            <Button
              disabled={
                busy ||
                locked ||
                ((state.phase === "intent" || state.phase === "questions") &&
                  (!state.intent.trim() ||
                    state.minutes < 1 ||
                    state.minutes > 180))
              }
              onClick={() =>
                void (state.phase === "intent" || state.phase === "questions"
                  ? prepare(state.round >= 2)
                  : state.phase === "plan"
                    ? confirmPlan()
                    : save())
              }
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              {busy
                ? "正在处理…"
                : state.phase === "agreement"
                  ? "保存学习计划"
                  : state.phase === "plan"
                    ? "确认方案"
                    : state.phase === "questions"
                      ? "继续"
                      : "生成推荐方案"}
              {!busy ? <ArrowRight /> : null}
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}

function AgreementEditor({
  plan,
  onChange,
}: {
  plan: LearningPlan
  onChange: (patch: Partial<LearningPlan>) => void
}) {
  const agreement = plan.observationAgreement
  const changeAgreement = (patch: Partial<ObservationAgreement>) =>
    onChange({ observationAgreement: { ...agreement, ...patch } })
  const offDevice = plan.observationProfile === "off_device_v1"
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="learning-mode">学习方式</Label>
        <select
          id="learning-mode"
          className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
          value={plan.observationProfile}
          onChange={(event) => {
            const profile = event.target
              .value as LearningPlan["observationProfile"]
            onChange({
              observationProfile: profile,
              observationAgreement: agreementForProfile(profile),
            })
          }}
        >
          {observationProfileValues.map((profile) => (
            <option key={profile} value={profile}>
              {observationProfiles[profile].label}
            </option>
          ))}
        </select>
        <p className="text-sm leading-6 text-slate-500">
          {observationProfiles[plan.observationProfile].description}
        </p>
      </div>
      {offDevice ? (
        <p className="border-l border-emerald-500 pl-4 text-sm leading-7 text-slate-600">
          运动、户外或离开设备时，摄像头无法可靠观察执行过程。本计划仍可计时、手动记录和复盘，默认不请求摄像头。
        </p>
      ) : (
        <>
          <div className="grid gap-5 sm:grid-cols-2">
            {(["phone", "tablet"] as const).map((device) => (
              <div key={device} className="space-y-2">
                <Label htmlFor={`agreement-${device}`}>
                  {device === "phone" ? "手机" : "平板"}
                </Label>
                <select
                  id={`agreement-${device}`}
                  className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                  value={agreement[device]}
                  onChange={(event) =>
                    changeAgreement({
                      [device]: event.target
                        .value as ObservationAgreement[typeof device],
                    })
                  }
                >
                  <option value="ignored">不观察</option>
                  <option value="allowed">允许用于学习</option>
                  <option value="restricted">本次不使用</option>
                </select>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="absence-seconds">持续离开画面，多久后提醒？</Label>
            <select
              id="absence-seconds"
              className="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
              value={agreement.absenceSeconds ?? "off"}
              onChange={(event) =>
                changeAgreement({
                  absenceSeconds:
                    event.target.value === "off"
                      ? null
                      : Number(event.target.value),
                })
              }
            >
              <option value="off">不提醒</option>
              {[30, 60, 120, 300, 600].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds < 60 ? `${seconds} 秒` : `${seconds / 60} 分钟`}
                </option>
              ))}
            </select>
          </div>
          {plan.observationProfile === "study_screen_v1" ? (
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-indigo-700"
                checked={agreement.screenDirection}
                onChange={(event) =>
                  changeAgreement({ screenDirection: event.target.checked })
                }
              />
              持续明显偏离屏幕方向时提醒
            </label>
          ) : (
            <p className="text-sm text-slate-600">
              纸笔学习允许正常低头，不会把低头本身当作偏离约定。
            </p>
          )}
        </>
      )}
      <div className="rounded-xl border border-indigo-100 bg-white p-5 text-sm leading-7 text-slate-600">
        <h2 className="font-semibold text-slate-900">
          确认约定，不等于开启摄像头
        </h2>
        <p className="mt-2">
          你仍需在开始学习后主动授权。手机与平板的语义分析还需要单独同意云端处理；拒绝后，计划、计时与复盘照常可用。看不清或无法可靠判断时，会明确标记为无法判断。
        </p>
        <p className="mt-2">
          不会输出专注分，也不会判断是否学会。约定会随计划版本保留，每次学习采用开始时的快照。
        </p>
      </div>
    </div>
  )
}
