import { createClient } from "@supabase/supabase-js"

import { mapTask, type Task } from "@/lib/domain"
import {
  learningPlanSchema,
  type LearningPlan,
  type PlanRevisionInput,
} from "@/lib/planning/contract"
import { manualLearningPlan } from "@/lib/planning/manual"
import { getSupabase } from "@/lib/supabase/client"
import { parseObservationAgreement } from "@/lib/vision/agreement"
import type { Database, Json } from "@/types/app-database"

export function planFromTask(task: Task, snapshot?: unknown): LearningPlan {
  const adopted = learningPlanSchema.safeParse(snapshot)
  const fallback = adopted.success
    ? adopted.data
    : manualLearningPlan(task.intent_text || task.title, task.estimated_minutes)
  return {
    ...fallback,
    title: task.title,
    context: learningPlanSchema.shape.context.safeParse(task.planning_context)
      .success
      ? (task.planning_context as Record<string, string>)
      : fallback.context,
    steps: task.steps,
    priority: task.priority,
    estimatedMinutes: task.estimated_minutes,
    purpose: task.learning_purpose || "",
    method: task.method_summary || fallback.method,
    selectedCriterion: task.completion_criterion || fallback.selectedCriterion,
    sessionMinutes:
      task.suggested_session_minutes || Math.min(25, task.estimated_minutes),
    observationProfile: task.observation_profile,
    observationAgreement: parseObservationAgreement(task.observation_agreement),
    dueAt: task.due_at || null,
  }
}

export async function getAdoptedPlan(userId: string, revisionId: string) {
  const { data, error } = await getSupabase()
    .from("task_plan_revisions")
    .select("snapshot")
    .eq("user_id", userId)
    .eq("id", revisionId)
    .maybeSingle()
  if (error) throw new Error("暂时无法读取实际采用的方案，请刷新后重试")
  return data?.snapshot ?? null
}

export async function saveLearningPlan(input: {
  userId: string
  requestId: string
  taskId?: string
  expectedRevisionId?: string | null
  plan: LearningPlan
  revisions: PlanRevisionInput[]
}) {
  const plan = learningPlanSchema.parse(input.plan)
  const { data: identity } = await getSupabase().auth.getSession()
  if (identity.session?.user.id !== input.userId)
    throw new Error("使用身份已改变，请重新打开制定计划页面")
  // Freeze the original identity for this write: an account switch while the
  // network request is pending must not import the old draft into a new user.
  const capturedToken = identity.session.access_token
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      accessToken: async () => capturedToken,
    },
  )
  const { data, error } = await supabase.rpc("save_learning_plan", {
    p_request_id: input.requestId,
    p_task_id: input.taskId ?? null,
    p_expected_revision_id: input.expectedRevisionId ?? null,
    p_plan: plan as unknown as Json,
    p_revisions: input.revisions as unknown as Json,
  })
  if (error) {
    if (error.code === "40001")
      throw new Error("学习计划已在其他页面更新，请刷新后再修改")
    if (error.message.includes("active learning session"))
      throw new Error("请先结束本次学习，再调整学习计划")
    if (error.message.includes("Completed steps"))
      throw new Error("已完成的执行步骤需要保留，不能删除或改写")
    throw new Error("保存学习计划失败，请检查网络和使用状态后重试")
  }
  if (!data || data.user_id !== input.userId)
    throw new Error("保存结果异常，请刷新后确认")
  return mapTask(data)
}

export async function listPlanRevisions(userId: string, taskId: string) {
  const { data, error } = await getSupabase()
    .from("task_plan_revisions")
    .select("*")
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .order("ordinal", { ascending: false })
    .limit(30)
  if (error) throw new Error("暂时无法读取调整记录")
  return data
}
