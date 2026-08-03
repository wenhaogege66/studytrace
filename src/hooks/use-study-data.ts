"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useExperience } from "@/components/experience/experience-provider"
import {
  createBehaviorEvent,
  createReminderEvent,
  createTask,
  deleteAllMyData,
  deleteBehaviorEvent,
  deleteTask,
  getActiveSession,
  getReview,
  getSession,
  getSettings,
  getTask,
  listBehaviorEvents,
  listTasks,
  loadSampleTasks,
  saveReview,
  setTaskStatus,
  startSession,
  updateBehaviorEvent,
  updateSession,
  updateSettings,
  updateTask,
} from "@/lib/data/study-repository"
import type {
  BehaviorEventType,
  CompletionStatus,
  EventDirection,
  EventSource,
  TaskDraft,
} from "@/lib/domain"
import type { TablesUpdate } from "@/types/database"

export const studyKeys = {
  tasks: (userId: string) => ["tasks", userId] as const,
  task: (userId: string, taskId: string) => ["task", userId, taskId] as const,
  activeSession: (userId: string) => ["active-session", userId] as const,
  session: (userId: string, sessionId: string) =>
    ["session", userId, sessionId] as const,
  events: (userId: string, sessionId: string) =>
    ["events", userId, sessionId] as const,
  review: (userId: string, sessionId: string) =>
    ["review", userId, sessionId] as const,
  settings: (userId: string) => ["settings", userId] as const,
}

function useUserId() {
  const { user } = useExperience()
  if (!user) throw new Error("Anonymous experience is not ready")
  return user.id
}

export function useTasks() {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.tasks(userId),
    queryFn: () => listTasks(userId),
  })
}

export function useTask(taskId: string | undefined) {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.task(userId, taskId ?? "missing"),
    queryFn: () => getTask(userId, taskId!),
    enabled: Boolean(taskId),
  })
}

export function useActiveSession() {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.activeSession(userId),
    queryFn: () => getActiveSession(userId),
  })
}

export function useSession(sessionId: string) {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.session(userId, sessionId),
    queryFn: () => getSession(userId, sessionId),
  })
}

export function useBehaviorEvents(sessionId: string) {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.events(userId, sessionId),
    queryFn: () => listBehaviorEvents(userId, sessionId),
  })
}

export function useReview(sessionId: string) {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.review(userId, sessionId),
    queryFn: () => getReview(userId, sessionId),
  })
}

export function useSettings() {
  const userId = useUserId()
  return useQuery({
    queryKey: studyKeys.settings(userId),
    queryFn: () => getSettings(userId),
  })
}

export function useTaskMutations() {
  const userId = useUserId()
  const queryClient = useQueryClient()
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: studyKeys.tasks(userId) })

  return {
    create: useMutation({
      mutationFn: (draft: TaskDraft) => createTask(userId, draft),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ taskId, draft }: { taskId: string; draft: TaskDraft }) =>
        updateTask(userId, taskId, draft),
      onSuccess: async (task) => {
        queryClient.setQueryData(studyKeys.task(userId, task.id), task)
        await refresh()
      },
    }),
    remove: useMutation({
      mutationFn: (taskId: string) => deleteTask(userId, taskId),
      onSuccess: refresh,
    }),
    setStatus: useMutation({
      mutationFn: ({
        taskId,
        status,
      }: {
        taskId: string
        status: "planned" | "in_progress" | "completed" | "archived"
      }) => setTaskStatus(userId, taskId, status),
      onSuccess: async (task) => {
        queryClient.setQueryData(studyKeys.task(userId, task.id), task)
        await refresh()
      },
    }),
    sample: useMutation({
      mutationFn: () => loadSampleTasks(userId),
      onSuccess: refresh,
    }),
  }
}

export function useSessionMutations() {
  const userId = useUserId()
  const queryClient = useQueryClient()

  return {
    start: useMutation({
      mutationFn: ({
        taskId,
        remindersEnabled,
        experimentMode,
      }: {
        taskId: string
        remindersEnabled: boolean
        experimentMode: boolean
      }) => startSession(userId, taskId, { remindersEnabled, experimentMode }),
      onSuccess: (session) => {
        queryClient.setQueryData(studyKeys.activeSession(userId), session)
        queryClient.setQueryData(studyKeys.session(userId, session.id), session)
        void queryClient.invalidateQueries({
          queryKey: studyKeys.tasks(userId),
        })
      },
    }),
    update: useMutation({
      mutationFn: ({
        sessionId,
        update,
      }: {
        sessionId: string
        update: TablesUpdate<"study_sessions">
      }) => updateSession(userId, sessionId, update),
      onSuccess: (session) => {
        queryClient.setQueryData(studyKeys.session(userId, session.id), session)
        queryClient.setQueryData(
          studyKeys.activeSession(userId),
          session.status === "running" || session.status === "paused"
            ? session
            : null,
        )
      },
    }),
  }
}

export function useEventMutations(sessionId: string) {
  const userId = useUserId()
  const queryClient = useQueryClient()
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: studyKeys.events(userId, sessionId),
    })

  return {
    create: useMutation({
      mutationFn: (input: {
        type: BehaviorEventType
        direction?: EventDirection | null
        source: EventSource
        startedAt: string
        endedAt?: string | null
      }) => createBehaviorEvent(userId, sessionId, input),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({
        eventId,
        update,
      }: {
        eventId: string
        update: TablesUpdate<"behavior_events">
      }) => updateBehaviorEvent(userId, eventId, update),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (eventId: string) => deleteBehaviorEvent(userId, eventId),
      onSuccess: refresh,
    }),
    reminder: useMutation({
      mutationFn: (eventId: string | null) =>
        createReminderEvent(userId, sessionId, eventId),
    }),
  }
}

export function useReviewMutation(sessionId: string) {
  const userId = useUserId()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      completionStatus: CompletionStatus
      selfRating: number
      incompleteReason: string
      nextAdjustment: string
    }) => saveReview(userId, sessionId, input),
    onSuccess: (review) =>
      queryClient.setQueryData(studyKeys.review(userId, sessionId), review),
  })
}

export function useSettingsMutations() {
  const userId = useUserId()
  const queryClient = useQueryClient()
  return {
    update: useMutation({
      mutationFn: (update: TablesUpdate<"user_settings">) =>
        updateSettings(userId, update),
      onSuccess: (settings) =>
        queryClient.setQueryData(studyKeys.settings(userId), settings),
    }),
    clear: useMutation({
      mutationFn: deleteAllMyData,
      onSuccess: () => {
        queryClient.removeQueries()
      },
    }),
  }
}
