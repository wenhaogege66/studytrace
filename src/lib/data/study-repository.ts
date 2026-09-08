import {
  createStep,
  mapBehaviorEvent,
  mapReview,
  mapSession,
  mapTask,
  stepsToJson,
  type BehaviorEvent,
  type BehaviorEventType,
  type CompletionStatus,
  type EventDirection,
  type EventSource,
  type Review,
  type SessionOutcome,
  type StudySession,
  type Task,
  type TaskDraft,
  type UserSettings,
} from "@/lib/domain"
import { getSupabase } from "@/lib/supabase/client"
import type { TablesUpdate } from "@/types/database"

type DataError = { code?: string; message: string }

function friendlyDataError(error: DataError) {
  if (
    error.message.includes("Task steps are complete") ||
    error.message.includes("confirm the task instead of starting")
  )
    return "全部步骤已完成，请先确认完成任务"
  if (error.message.includes("Complete every task step"))
    return "请先完成所有任务步骤"
  if (error.message.includes("Only completed tasks can be reopened"))
    return "只有已完成任务可以重新打开"
  if (error.message.includes("Completed or archived tasks cannot start"))
    return "已完成或已归档任务不能直接开始"
  if (
    error.code === "42501" ||
    error.message.toLocaleLowerCase().includes("row-level security") ||
    error.message.toLocaleLowerCase().includes("permission denied")
  )
    return "当前体验会话已失效或没有权限，请刷新页面后重试"
  if (
    error.message.toLocaleLowerCase().includes("fetch failed") ||
    error.message.toLocaleLowerCase().includes("failed to fetch")
  )
    return "网络连接失败，请检查网络后重试"
  return error.message
}

function fail(message: string, error: DataError): never {
  throw new Error(`${message}：${friendlyDataError(error)}`)
}

export async function ensureSettings(userId: string) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle()
  if (error) fail("读取设置失败", error)
  if (data) return data

  const result = await supabase
    .from("user_settings")
    .upsert({ user_id: userId }, { onConflict: "user_id" })
    .select()
    .single()
  if (result.error) fail("初始化设置失败", result.error)
  return result.data
}

export async function listTasks(userId: string): Promise<Task[]> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
  if (error) fail("读取任务失败", error)
  return data.map(mapTask)
}

export async function getTask(
  userId: string,
  taskId: string,
): Promise<Task | null> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("id", taskId)
    .maybeSingle()
  if (error) fail("读取任务失败", error)
  return data ? mapTask(data) : null
}

export async function createTask(
  userId: string,
  draft: TaskDraft,
): Promise<Task> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .insert({
      user_id: userId,
      title: draft.title.trim(),
      steps: stepsToJson(draft.steps),
      priority: draft.priority,
      estimated_minutes: draft.estimatedMinutes,
      observation_profile: draft.observationProfile,
    })
    .select()
    .single()
  if (error) fail("创建任务失败", error)
  return mapTask(data)
}

export async function updateTask(
  userId: string,
  taskId: string,
  draft: TaskDraft,
): Promise<Task> {
  const { data, error } = await getSupabase()
    .from("tasks")
    .update({
      title: draft.title.trim(),
      steps: stepsToJson(draft.steps),
      priority: draft.priority,
      estimated_minutes: draft.estimatedMinutes,
      observation_profile: draft.observationProfile,
    })
    .eq("user_id", userId)
    .eq("id", taskId)
    .select()
    .single()
  if (error) fail("更新任务失败", error)
  return mapTask(data)
}

export async function duplicateTask(userId: string, task: Task): Promise<Task> {
  return createTask(userId, {
    title: `${task.title}（副本）`,
    steps: task.steps.map((step) => createStep(step.title)),
    priority: task.priority,
    estimatedMinutes: task.estimated_minutes,
    observationProfile: task.observation_profile,
  })
}

export async function setTaskStepCompleted(
  userId: string,
  taskId: string,
  stepId: string,
  completed: boolean,
): Promise<Task> {
  const { data, error } = await getSupabase().rpc("set_task_step_completed", {
    p_task_id: taskId,
    p_step_id: stepId,
    p_completed: completed,
  })
  if (error) fail("更新任务步骤失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("更新任务步骤失败：返回数据异常")
  return mapTask(data)
}

export async function confirmTaskCompletion(
  userId: string,
  taskId: string,
  accumulatedSeconds?: number,
): Promise<Task> {
  const { data, error } = await getSupabase().rpc("confirm_task_completion", {
    p_task_id: taskId,
    ...(accumulatedSeconds === undefined
      ? {}
      : {
          p_accumulated_seconds: Math.max(0, Math.floor(accumulatedSeconds)),
        }),
  })
  if (error) fail("确认完成失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("确认完成失败：返回数据异常")
  return mapTask(data)
}

export async function reopenCompletedTask(
  userId: string,
  taskId: string,
): Promise<Task> {
  const { data, error } = await getSupabase().rpc("reopen_completed_task", {
    p_task_id: taskId,
  })
  if (error) fail("重新打开任务失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("重新打开任务失败：返回数据异常")
  return mapTask(data)
}

export async function deleteTask(userId: string, taskId: string) {
  const { error } = await getSupabase()
    .from("tasks")
    .delete()
    .eq("user_id", userId)
    .eq("id", taskId)
  if (error) fail("删除任务失败", error)
}

export async function setTaskStatus(
  userId: string,
  taskId: string,
  status: "planned" | "in_progress" | "completed" | "archived",
) {
  const { data, error } = await getSupabase()
    .from("tasks")
    .update({
      status,
      completed_at: status === "completed" ? new Date().toISOString() : null,
    })
    .eq("user_id", userId)
    .eq("id", taskId)
    .select()
    .single()
  if (error) fail("更新任务状态失败", error)
  return mapTask(data)
}

export async function loadSampleTasks(userId: string): Promise<Task[]> {
  const samples: TaskDraft[] = [
    {
      title: "完成光合作用实验复盘",
      priority: "high",
      estimatedMinutes: 35,
      observationProfile: "study_paper_v1",
      steps: ["整理实验现象", "解释变量关系", "写下一个新问题"].map(
        (title, index) => ({
          id: `sample-biology-${index + 1}`,
          title,
          completed: false,
        }),
      ),
    },
    {
      title: "练习三道函数综合题",
      priority: "medium",
      estimatedMinutes: 45,
      observationProfile: "study_paper_v1",
      steps: ["标注已知条件", "独立完成推导", "核对错因"].map(
        (title, index) => ({
          id: `sample-math-${index + 1}`,
          title,
          completed: false,
        }),
      ),
    },
  ]
  return Promise.all(samples.map((sample) => createTask(userId, sample)))
}

export async function startSession(
  userId: string,
  taskId: string,
  options: { remindersEnabled: boolean; experimentMode: boolean },
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc("start_study_session", {
    p_task_id: taskId,
    p_reminders_enabled: options.remindersEnabled,
    p_experiment_mode: options.experimentMode,
  })
  if (error) fail("开始学习失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("开始学习失败：返回数据异常")
  return mapSession(data)
}

export async function finishSession(
  userId: string,
  sessionId: string,
  accumulatedSeconds: number,
  taskOutcome: SessionOutcome,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc("finish_study_session", {
    p_session_id: sessionId,
    p_accumulated_seconds: Math.max(0, Math.floor(accumulatedSeconds)),
    p_task_outcome: taskOutcome,
  })
  if (error) fail("结束学习失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("结束学习失败：返回数据异常")
  return mapSession(data)
}

export async function cancelSession(
  userId: string,
  sessionId: string,
  accumulatedSeconds: number,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc("cancel_study_session", {
    p_session_id: sessionId,
    p_accumulated_seconds: Math.max(0, Math.floor(accumulatedSeconds)),
  })
  if (error) fail("结束本次学习失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("结束本次学习失败：返回数据异常")
  return mapSession(data)
}

export async function getActiveSession(
  userId: string,
): Promise<StudySession | null> {
  const { data, error } = await getSupabase()
    .from("study_sessions")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["running", "paused"])
    .maybeSingle()
  if (error) fail("读取活动学习失败", error)
  return data ? mapSession(data) : null
}

export async function getSession(
  userId: string,
  sessionId: string,
): Promise<StudySession | null> {
  const { data, error } = await getSupabase()
    .from("study_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("id", sessionId)
    .maybeSingle()
  if (error) fail("读取学习记录失败", error)
  return data ? mapSession(data) : null
}

export async function listTaskSessions(
  userId: string,
  taskId: string,
): Promise<StudySession[]> {
  const { data, error } = await getSupabase()
    .from("study_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .order("started_at", { ascending: false })
    .limit(5)
  if (error) fail("读取学习记录失败", error)
  return data.map(mapSession)
}

export async function pauseSession(
  userId: string,
  sessionId: string,
  expectedStateVersion: number,
  accumulatedSeconds: number,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc("pause_study_session", {
    p_session_id: sessionId,
    p_expected_state_version: expectedStateVersion,
    p_accumulated_seconds: accumulatedSeconds,
  })
  if (error) fail("暂停学习失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("暂停学习失败：返回数据异常")
  return mapSession(data)
}

export async function resumeSession(
  userId: string,
  sessionId: string,
  expectedStateVersion: number,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc("resume_study_session", {
    p_session_id: sessionId,
    p_expected_state_version: expectedStateVersion,
  })
  if (error) fail("恢复学习失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("恢复学习失败：返回数据异常")
  return mapSession(data)
}

export async function setSessionCameraEnabled(
  userId: string,
  sessionId: string,
  expectedStateVersion: number,
  cameraVersion: number,
  enabled: boolean,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc("set_study_session_camera", {
    p_session_id: sessionId,
    p_expected_state_version: expectedStateVersion,
    p_camera_version: cameraVersion,
    p_enabled: enabled,
  })
  if (error) fail("保存摄像头状态失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("保存摄像头状态失败：返回数据异常")
  return mapSession(data)
}

export async function checkpointRunningSession(
  userId: string,
  sessionId: string,
  expectedResumedAt: string,
  accumulatedSeconds: number,
  checkpointedAt: string,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc(
    "checkpoint_running_session",
    {
      p_session_id: sessionId,
      p_expected_resumed_at: expectedResumedAt,
      p_accumulated_seconds: accumulatedSeconds,
      p_checkpointed_at: checkpointedAt,
    },
  )
  if (error) fail("保存学习计时失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("保存学习计时失败：返回数据异常")
  return mapSession(data)
}

export async function pauseRunningSessionForNavigation(
  userId: string,
  sessionId: string,
): Promise<StudySession> {
  const { data, error } = await getSupabase().rpc(
    "pause_study_session_for_navigation",
    { p_session_id: sessionId },
  )
  if (error) fail("离开前暂停学习失败", error)
  if (!data || data.user_id !== userId)
    throw new Error("离开前暂停学习失败：返回数据异常")
  return mapSession(data)
}

export async function listBehaviorEvents(
  userId: string,
  sessionId: string,
): Promise<BehaviorEvent[]> {
  const { data, error } = await getSupabase()
    .from("behavior_events")
    .select("*")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("started_at", { ascending: true })
  if (error) fail("读取观察事件失败", error)
  return data.map(mapBehaviorEvent)
}

export async function createBehaviorEvent(
  userId: string,
  sessionId: string,
  input: {
    type: BehaviorEventType
    direction?: EventDirection | null
    source: EventSource
    startedAt: string
    endedAt?: string | null
  },
): Promise<BehaviorEvent> {
  const { data, error } = await getSupabase()
    .from("behavior_events")
    .insert({
      user_id: userId,
      session_id: sessionId,
      event_type: input.type,
      direction: input.direction,
      source: input.source,
      started_at: input.startedAt,
      ended_at: input.endedAt,
    })
    .select()
    .single()
  if (error) fail("记录观察事件失败", error)
  return mapBehaviorEvent(data)
}

export async function updateBehaviorEvent(
  userId: string,
  eventId: string,
  update: TablesUpdate<"behavior_events">,
): Promise<BehaviorEvent> {
  const { data, error } = await getSupabase()
    .from("behavior_events")
    .update(update)
    .eq("user_id", userId)
    .eq("id", eventId)
    .select()
    .single()
  if (error) fail("更新观察事件失败", error)
  return mapBehaviorEvent(data)
}

export async function deleteBehaviorEvent(userId: string, eventId: string) {
  const { error } = await getSupabase()
    .from("behavior_events")
    .delete()
    .eq("user_id", userId)
    .eq("id", eventId)
  if (error) fail("删除观察事件失败", error)
}

export async function createReminderEvent(
  userId: string,
  sessionId: string,
  behaviorEventId: string | null,
) {
  const { error } = await getSupabase().from("reminder_events").insert({
    user_id: userId,
    session_id: sessionId,
    behavior_event_id: behaviorEventId,
  })
  if (error) fail("记录提醒失败", error)
}

export async function getReview(
  userId: string,
  sessionId: string,
): Promise<Review | null> {
  const { data, error } = await getSupabase()
    .from("reviews")
    .select("*")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .maybeSingle()
  if (error) fail("读取复盘失败", error)
  return data ? mapReview(data) : null
}

export async function saveReview(
  userId: string,
  sessionId: string,
  input: {
    completionStatus: CompletionStatus
    selfRating: number
    incompleteReason: string
    nextAdjustment: string
  },
): Promise<Review> {
  const payload = {
    user_id: userId,
    session_id: sessionId,
    completion_status: input.completionStatus,
    self_rating: input.selfRating,
    incomplete_reason: input.incompleteReason.trim() || null,
    next_adjustment: input.nextAdjustment.trim() || null,
  }
  const { data, error } = await getSupabase()
    .from("reviews")
    .upsert(payload, { onConflict: "session_id" })
    .select()
    .single()
  if (error) fail("保存复盘失败", error)
  return mapReview(data)
}

export async function getSettings(userId: string): Promise<UserSettings> {
  return ensureSettings(userId)
}

export async function updateSettings(
  userId: string,
  update: TablesUpdate<"user_settings">,
): Promise<UserSettings> {
  const { data, error } = await getSupabase()
    .from("user_settings")
    .update(update)
    .eq("user_id", userId)
    .select()
    .single()
  if (error) fail("保存设置失败", error)
  return data
}

export async function deleteAllMyData() {
  const { error } = await getSupabase().rpc("delete_my_data")
  if (error) fail("清除全部数据失败", error)
}
