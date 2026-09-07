"use client"

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"

import { useExperience } from "@/components/experience/experience-provider"
import {
  checkpointRunningSession,
  cancelSession,
  createBehaviorEvent,
  createReminderEvent,
  createTask,
  deleteAllMyData,
  deleteBehaviorEvent,
  deleteTask,
  finishSession,
  getActiveSession,
  getReview,
  getSession,
  getSettings,
  getTask,
  listBehaviorEvents,
  listTasks,
  loadSampleTasks,
  pauseRunningSessionForNavigation,
  pauseSession,
  resumeSession,
  saveReview,
  setSessionCameraEnabled,
  setTaskStepCompleted,
  setTaskStatus,
  startSession,
  updateBehaviorEvent,
  updateSettings,
  updateTask,
} from "@/lib/data/study-repository"
import type {
  BehaviorEventType,
  CompletionStatus,
  EventDirection,
  EventSource,
  SessionOutcome,
  StudySession,
  TaskDraft,
} from "@/lib/domain"
import {
  mergeActiveMutationSnapshot,
  mergeActiveQuerySnapshot,
  mergeSessionSnapshot,
} from "@/lib/session/cache"
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

function cacheSession(
  queryClient: QueryClient,
  userId: string,
  incoming: StudySession,
) {
  let accepted = false
  queryClient.setQueryData<StudySession | null>(
    studyKeys.session(userId, incoming.id),
    (current) => {
      const merged = mergeSessionSnapshot(current, incoming)
      accepted = merged === incoming
      return merged
    },
  )
  if (!accepted) return

  let conflict = false
  queryClient.setQueryData<StudySession | null>(
    studyKeys.activeSession(userId),
    (current) => {
      const merged = mergeActiveMutationSnapshot(current, incoming)
      conflict = merged.conflict
      return merged.value
    },
  )
  if (conflict)
    void queryClient.invalidateQueries({
      queryKey: studyKeys.activeSession(userId),
    })
}

async function cancelSessionQueries(
  queryClient: QueryClient,
  userId: string,
  sessionId: string,
) {
  await Promise.all([
    queryClient.cancelQueries({
      queryKey: studyKeys.session(userId, sessionId),
    }),
    queryClient.cancelQueries({ queryKey: studyKeys.activeSession(userId) }),
  ])
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
  return useQuery<StudySession | null>({
    queryKey: studyKeys.activeSession(userId),
    queryFn: () => getActiveSession(userId),
    structuralSharing: (current, incoming) =>
      mergeActiveQuerySnapshot(
        current as StudySession | null | undefined,
        incoming as StudySession | null,
      ),
  })
}

export function useSession(sessionId: string | undefined) {
  const userId = useUserId()
  return useQuery<StudySession | null>({
    queryKey: studyKeys.session(userId, sessionId ?? "missing"),
    queryFn: () => getSession(userId, sessionId!),
    enabled: Boolean(sessionId),
    structuralSharing: (current, incoming) =>
      mergeSessionSnapshot(
        current as StudySession | null | undefined,
        incoming as StudySession | null,
      ),
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
    step: useMutation({
      mutationFn: ({
        taskId,
        stepId,
        completed,
      }: {
        taskId: string
        stepId: string
        completed: boolean
      }) => setTaskStepCompleted(userId, taskId, stepId, completed),
      onSuccess: async (task) => {
        queryClient.setQueryData(studyKeys.task(userId, task.id), task)
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: studyKeys.task(userId, task.id),
          }),
          refresh(),
        ])
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
      onMutate: () =>
        queryClient.cancelQueries({
          queryKey: studyKeys.activeSession(userId),
        }),
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
        cacheSession(queryClient, userId, session)
        void queryClient.invalidateQueries({
          queryKey: studyKeys.tasks(userId),
        })
      },
    }),
    pause: useMutation({
      onMutate: ({ sessionId }) =>
        cancelSessionQueries(queryClient, userId, sessionId),
      mutationFn: ({
        sessionId,
        expectedStateVersion,
        accumulatedSeconds,
      }: {
        sessionId: string
        expectedStateVersion: number
        accumulatedSeconds: number
      }) =>
        pauseSession(
          userId,
          sessionId,
          expectedStateVersion,
          accumulatedSeconds,
        ),
      onSuccess: (session) => cacheSession(queryClient, userId, session),
    }),
    resume: useMutation({
      onMutate: ({ sessionId }) =>
        cancelSessionQueries(queryClient, userId, sessionId),
      mutationFn: ({
        sessionId,
        expectedStateVersion,
      }: {
        sessionId: string
        expectedStateVersion: number
      }) => resumeSession(userId, sessionId, expectedStateVersion),
      onSuccess: (session) => cacheSession(queryClient, userId, session),
    }),
    camera: useMutation({
      mutationFn: ({
        sessionId,
        expectedStateVersion,
        cameraVersion,
        enabled,
      }: {
        sessionId: string
        expectedStateVersion: number
        cameraVersion: number
        enabled: boolean
      }) =>
        setSessionCameraEnabled(
          userId,
          sessionId,
          expectedStateVersion,
          cameraVersion,
          enabled,
        ),
    }),
    checkpoint: useMutation({
      mutationFn: ({
        sessionId,
        expectedResumedAt,
        accumulatedSeconds,
        checkpointedAt,
      }: {
        sessionId: string
        expectedResumedAt: string
        accumulatedSeconds: number
        checkpointedAt: string
      }) =>
        checkpointRunningSession(
          userId,
          sessionId,
          expectedResumedAt,
          accumulatedSeconds,
          checkpointedAt,
        ),
    }),
    finish: useMutation({
      onMutate: ({ sessionId }) =>
        cancelSessionQueries(queryClient, userId, sessionId),
      mutationFn: ({
        sessionId,
        accumulatedSeconds,
        taskOutcome,
      }: {
        sessionId: string
        accumulatedSeconds: number
        taskOutcome: SessionOutcome
      }) => finishSession(userId, sessionId, accumulatedSeconds, taskOutcome),
      onSuccess: (session) => {
        cacheSession(queryClient, userId, session)
        void queryClient.invalidateQueries({
          queryKey: studyKeys.task(userId, session.task_id),
        })
        void queryClient.invalidateQueries({
          queryKey: studyKeys.tasks(userId),
        })
      },
    }),
    cancel: useMutation({
      onMutate: ({ sessionId }) =>
        cancelSessionQueries(queryClient, userId, sessionId),
      mutationFn: ({
        sessionId,
        accumulatedSeconds,
      }: {
        sessionId: string
        accumulatedSeconds: number
      }) => cancelSession(userId, sessionId, accumulatedSeconds),
      onSuccess: (session) => {
        cacheSession(queryClient, userId, session)
        void queryClient.invalidateQueries({
          queryKey: studyKeys.task(userId, session.task_id),
        })
        void queryClient.invalidateQueries({
          queryKey: studyKeys.tasks(userId),
        })
      },
    }),
  }
}

export function usePauseSessionForNavigation() {
  const userId = useUserId()
  const queryClient = useQueryClient()

  return useMutation({
    onMutate: (sessionId: string) =>
      cancelSessionQueries(queryClient, userId, sessionId),
    mutationFn: (sessionId: string) =>
      pauseRunningSessionForNavigation(sessionId),
    onSuccess: (session) => cacheSession(queryClient, userId, session),
  })
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
