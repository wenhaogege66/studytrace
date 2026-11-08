"use client"

import {
  Camera,
  CameraOff,
  Eye,
  FlaskConical,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CloudObservation } from "@/components/session/cloud-observation"
import {
  parseObservationAgreement,
  type ObservationAgreement,
} from "@/lib/vision/agreement"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { useEventMutations } from "@/hooks/use-study-data"
import type { ReminderResponse } from "@/lib/data/study-repository"
import type { EventDirection } from "@/lib/domain"
import {
  createDetectorState,
  DEFAULT_THRESHOLDS,
  EXPERIMENT_THRESHOLDS,
  processObservation,
  type DetectorEffect,
  type DetectorState,
  type VisionObservation,
  type VisionThresholds,
} from "@/lib/vision/detector"
import {
  getObservationProfile,
  type ObservationProfile,
} from "@/lib/vision/profiles"

type WorkerMessage =
  | { type: "ready"; objectDetectorReady?: boolean }
  | { type: "observation"; frameId: number; observation: VisionObservation }
  | { type: "error" | "frame_error"; frameId?: number; message: string }
  | { type: "stopped" }

type VisionPhase =
  "idle" | "requesting" | "loading" | "calibrating" | "observing" | "error"

export const VISION_MODEL_INIT_TIMEOUT_MS = 20_000
const EVENT_CLOSE_RETRY_DELAYS_MS = [0, 150, 500] as const
const CAMERA_STATE_RETRY_DELAYS_MS = [0, 150, 500] as const

function directionLabel(direction: EventDirection | null) {
  if (direction === "left") return "向左"
  if (direction === "right") return "向右"
  if (direction === "down") return "低头"
  return ""
}

export function VisionPanel({
  sessionId,
  paused,
  experimentMode,
  observationProfile,
  settings,
  onObservationHeartbeat = () => undefined,
  onCameraStateChange,
  observationAgreement,
  onValidCoverage,
}: {
  sessionId: string
  paused: boolean
  experimentMode: boolean
  observationProfile: ObservationProfile
  observationAgreement?: ObservationAgreement
  onValidCoverage?: (input: {
    deltaMs: number
    totalMs: number
    at: string
  }) => void
  settings?: {
    calibration_seconds: number
    sample_fps: number
    face_absent_seconds: number
    direction_hold_seconds: number
    neutral_recovery_seconds: number
    reminder_delay_seconds: number
    reminder_cooldown_seconds: number
    yaw_threshold_degrees: number
    pitch_threshold_degrees: number
    reminders_enabled: boolean
  }
  onObservationHeartbeat?: () => Promise<void> | void
  onCameraStateChange: (enabled: boolean) => Promise<void> | void
}) {
  const profile = getObservationProfile(observationProfile)
  const agreement = parseObservationAgreement(observationAgreement)
  const events = useEventMutations(sessionId)
  const [phase, setPhase] = useState<VisionPhase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [statusText, setStatusText] = useState("摄像头未开启")
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [calibrationWaitingForFace, setCalibrationWaitingForFace] =
    useState(true)
  const [pendingReminderIds, setPendingReminderIds] = useState<string[]>([])
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startOperationRef = useRef(0)
  const inferenceBusyRef = useRef(false)
  const detectorRef = useRef<DetectorState>(createDetectorState())
  const activeEventIdRef = useRef<string | null>(null)
  const activeEventEndAtRef = useRef<string | null>(null)
  const effectsQueueRef = useRef<Promise<void>>(Promise.resolve())
  const mountedRef = useRef(true)
  const stoppingRef = useRef(false)
  const observationHeartbeatRef = useRef(onObservationHeartbeat)

  useEffect(() => {
    observationHeartbeatRef.current = onObservationHeartbeat
  }, [onObservationHeartbeat])
  const frameSequenceRef = useRef(0)
  const pendingFrameRef = useRef<number | null>(null)
  const frameTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workerFailureRef = useRef<() => void>(() => undefined)
  const lastVideoTimeRef = useRef(-1)
  const lastVideoChangeRef = useRef(0)
  const lastValidAtRef = useRef(0)
  const [coverageMs, setCoverageMs] = useState(0)
  const coverageTotalRef = useRef(0)
  const [actualFps, setActualFps] = useState(0)
  const [objectsReady, setObjectsReady] = useState(false)
  const frameTimesRef = useRef<number[]>([])
  const coverageCallbackRef = useRef(onValidCoverage)
  useEffect(() => {
    coverageCallbackRef.current = onValidCoverage
  }, [onValidCoverage])

  const thresholds: VisionThresholds = useMemo(
    () =>
      experimentMode
        ? EXPERIMENT_THRESHOLDS
        : {
            ...DEFAULT_THRESHOLDS,
            calibrationMs: (settings?.calibration_seconds ?? 3) * 1_000,
            faceAbsentMs: (agreement.absenceSeconds ?? 60) * 1_000,
            directionHoldMs: (settings?.direction_hold_seconds ?? 3) * 1_000,
            neutralRecoveryMs:
              (settings?.neutral_recovery_seconds ?? 1) * 1_000,
            reminderDelayMs: (settings?.reminder_delay_seconds ?? 15) * 1_000,
            reminderCooldownMs:
              (settings?.reminder_cooldown_seconds ?? 600) * 1_000,
            yawDegrees: settings?.yaw_threshold_degrees ?? 25,
            pitchDegrees: settings?.pitch_threshold_degrees ?? 20,
          },
    [experimentMode, agreement.absenceSeconds, settings],
  )
  const thresholdRef = useRef(thresholds)
  useEffect(() => {
    thresholdRef.current = thresholds
  }, [thresholds])

  const finishActiveEvent = useCallback(
    async (endedAtMs?: number) => {
      const eventId = activeEventIdRef.current
      if (!eventId) return true
      const endedAt =
        activeEventEndAtRef.current ??
        new Date(endedAtMs ?? Date.now()).toISOString()
      activeEventEndAtRef.current = endedAt

      for (const delayMs of EVENT_CLOSE_RETRY_DELAYS_MS) {
        if (delayMs)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        try {
          await events.update.mutateAsync({
            eventId,
            update: { ended_at: endedAt },
          })
          if (activeEventIdRef.current === eventId) {
            activeEventIdRef.current = null
            activeEventEndAtRef.current = null
          }
          return true
        } catch {
          // Keep the event id and original end time for this or a later retry.
        }
      }
      return false
    },
    [events.update],
  )
  const finishActiveEventRef = useRef(finishActiveEvent)
  useEffect(() => {
    finishActiveEventRef.current = finishActiveEvent
  }, [finishActiveEvent])

  const syncCameraState = useCallback(
    async (enabled: boolean, canRetry: () => boolean = () => true) => {
      for (const delayMs of CAMERA_STATE_RETRY_DELAYS_MS) {
        if (!canRetry()) return false
        if (delayMs)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (!canRetry()) return false
        try {
          await onCameraStateChange(enabled)
          return true
        } catch {
          // A lost response can hide a successful write, so retry the same
          // desired state. The server-side camera version makes it idempotent.
        }
      }
      return false
    },
    [onCameraStateChange],
  )
  const syncCameraStateRef = useRef(syncCameraState)
  useEffect(() => {
    syncCameraStateRef.current = syncCameraState
  }, [syncCameraState])

  const stop = useCallback(
    async (failureMessage?: string) => {
      if (stoppingRef.current) return
      stoppingRef.current = true
      try {
        window.dispatchEvent(new Event("studytrace:observation-stopping"))
        if (mountedRef.current) setPhase("idle")
        startOperationRef.current += 1
        if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
        if (frameTimeoutRef.current) clearTimeout(frameTimeoutRef.current)
        pendingFrameRef.current = null
        lastValidAtRef.current = 0
        initTimeoutRef.current = null
        if (intervalRef.current) clearInterval(intervalRef.current)
        intervalRef.current = null
        workerRef.current?.postMessage({ type: "stop" })
        workerRef.current?.terminate()
        workerRef.current = null
        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
        await effectsQueueRef.current
        const eventClosed = await finishActiveEvent(
          detectorRef.current.lastTimestampMs ?? undefined,
        )
        inferenceBusyRef.current = false
        detectorRef.current = createDetectorState()
        const cameraStateSynced = await syncCameraState(false)
        if (mountedRef.current) {
          if (!eventClosed)
            toast.error("观察事件结束时间暂未同步，下次关闭时会继续重试")
          if (!cameraStateSynced)
            toast.error(
              "本地摄像头已关闭，但观察记录暂未同步；暂停学习可再次收口",
            )
          setPhase(failureMessage || !cameraStateSynced ? "error" : "idle")
          setError(
            failureMessage ??
              (cameraStateSynced
                ? null
                : "本地画面和推理已停止，但观察区间暂未同步。请检查网络后重试，或暂停本次学习。"),
          )
          setStatusText(
            failureMessage ? "本地视觉已停止" : "摄像头已关闭，本地推理已停止",
          )
          setCalibrationProgress(0)
          setCalibrationWaitingForFace(true)
        }
      } finally {
        stoppingRef.current = false
      }
    },
    [finishActiveEvent, syncCameraState],
  )

  const handleEffects = useCallback(
    async (effects: DetectorEffect[]) => {
      for (const effect of effects) {
        if (effect.type === "calibrated") {
          setPhase("observing")
          setCalibrationProgress(100)
          setCalibrationWaitingForFace(false)
          setStatusText(`${profile.shortLabel}基线已建立，正在本地观察`)
          continue
        }
        if (effect.type === "event_started") {
          setStatusText(
            effect.kind === "face_absent"
              ? "观察到：暂时未在画面"
              : `观察到：头部方向明显变化 ${directionLabel(effect.direction)}`,
          )
          try {
            if (
              activeEventIdRef.current &&
              !(await finishActiveEvent(effect.atMs))
            ) {
              toast.error("上一条观察事件尚未收口，已暂停新事件写入")
              continue
            }
            const created = await events.create.mutateAsync({
              type: effect.kind,
              direction: effect.direction,
              source: "vision",
              startedAt: new Date(effect.atMs).toISOString(),
            })
            activeEventIdRef.current = created.id
            activeEventEndAtRef.current = null
          } catch (eventError) {
            toast.error(
              eventError instanceof Error
                ? eventError.message
                : "观察事件暂未保存",
            )
          }
          continue
        }
        if (effect.type === "event_ended") {
          const eventClosed = await finishActiveEvent(effect.atMs)
          if (!eventClosed) toast.error("观察事件暂未收口，会在后续操作中重试")
          setStatusText("已恢复中性状态")
          continue
        }
        if (
          effect.type === "reminder" &&
          (settings?.reminders_enabled ?? true)
        ) {
          toast("回到当前这一步", {
            description:
              observationProfile === "study_paper_v1"
                ? "检测到持续离开画面或大幅侧转；不会直接按低头角度提醒。"
                : "检测到一个持续画面事件。这只是轻提醒，不是对专注程度的判断。",
            duration: 6_000,
          })
          try {
            const reminder = await events.reminder.mutateAsync(
              activeEventIdRef.current,
            )
            setPendingReminderIds((current) =>
              current.includes(reminder.id)
                ? current
                : [...current, reminder.id],
            )
          } catch (reminderError) {
            toast.error(
              reminderError instanceof Error
                ? reminderError.message
                : "轻提醒暂未记录",
            )
          }
        }
      }
    },
    [
      events.create,
      events.reminder,
      finishActiveEvent,
      observationProfile,
      profile.shortLabel,
      settings?.reminders_enabled,
    ],
  )

  const startSampling = useCallback(() => {
    const fps = 4
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(
      () => {
        void (async () => {
          const video = videoRef.current
          const worker = workerRef.current
          if (document.hidden) {
            void stop()
            return
          }
          if (video && video.currentTime === lastVideoTimeRef.current) {
            if (
              lastVideoChangeRef.current &&
              Date.now() - lastVideoChangeRef.current > 3_000
            )
              void stop("摄像头画面已冻结，观察已停止。计时仍可继续。")
            return
          }
          if (
            !video ||
            !worker ||
            inferenceBusyRef.current ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
          )
            return
          inferenceBusyRef.current = true
          lastVideoTimeRef.current = video.currentTime
          lastVideoChangeRef.current = Date.now()
          const operationId = startOperationRef.current
          const frameId = ++frameSequenceRef.current
          pendingFrameRef.current = frameId
          let bitmap: ImageBitmap | null = null
          try {
            bitmap = await createImageBitmap(video)
            if (
              operationId !== startOperationRef.current ||
              worker !== workerRef.current ||
              document.hidden
            ) {
              bitmap.close()
              inferenceBusyRef.current = false
              return
            }
            worker.postMessage(
              {
                type: "detect",
                bitmap,
                timestampMs: performance.timeOrigin + performance.now(),
                frameId,
              },
              [bitmap],
            )
            frameTimeoutRef.current = setTimeout(
              () => workerFailureRef.current(),
              2_000,
            )
          } catch {
            bitmap?.close()
            inferenceBusyRef.current = false
            workerFailureRef.current()
          }
        })()
      },
      Math.round(1_000 / fps),
    )
  }, [stop])

  const start = async () => {
    if (stoppingRef.current) return
    if (document.hidden) return
    if (!profile.cameraEnabled) {
      toast.info("这个任务设置为离开设备完成，不会请求摄像头")
      return
    }
    if (paused) {
      toast.info("请先恢复计时，再开启观察")
      return
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof Worker === "undefined"
    ) {
      setError(
        "当前浏览器不支持所需的摄像头或 Worker 能力。计时与复盘仍可正常使用。",
      )
      setPhase("error")
      return
    }

    setError(null)
    setPhase("requesting")
    setStatusText("等待摄像头授权")
    setCalibrationWaitingForFace(true)
    setCalibrationProgress(0)
    const operationId = startOperationRef.current + 1
    startOperationRef.current = operationId
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      })
      if (!mountedRef.current || operationId !== startOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      lastVideoTimeRef.current = -1
      lastVideoChangeRef.current = Date.now()
      setCoverageMs(0)
      coverageTotalRef.current = 0
      setActualFps(0)
      frameTimesRef.current = []
      stream.getVideoTracks?.().forEach((track) =>
        track.addEventListener?.("ended", () => {
          if (operationId === startOperationRef.current)
            void stop("摄像头已断开，观察已停止。计时仍可继续。")
        }),
      )
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      if (!mountedRef.current || operationId !== startOperationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        if (streamRef.current === stream) streamRef.current = null
        if (videoRef.current?.srcObject === stream)
          videoRef.current.srcObject = null
        return
      }
      setPhase("loading")
      setStatusText("正在本地加载视觉模型")
      let restarts = 0
      let consecutiveErrors = 0
      const launchWorker = () => {
        const worker = new Worker(
          new URL("../../workers/vision.worker.ts", import.meta.url),
          { type: "module" },
        )
        workerRef.current = worker
        const recover = () => {
          if (
            operationId !== startOperationRef.current ||
            workerRef.current !== worker
          )
            return
          if (frameTimeoutRef.current) clearTimeout(frameTimeoutRef.current)
          if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
          if (intervalRef.current) clearInterval(intervalRef.current)
          worker.terminate()
          inferenceBusyRef.current = false
          pendingFrameRef.current = null
          lastValidAtRef.current = 0
          const oldLast = detectorRef.current.lastTimestampMs
          effectsQueueRef.current = effectsQueueRef.current
            .then(() => finishActiveEvent(oldLast ?? undefined))
            .then(() => undefined)
          detectorRef.current = createDetectorState()
          if (++restarts > 2) {
            void stop(
              "观察连续中断，已停止摄像头。请重试；计时与手动复盘仍可继续。",
            )
            return
          }
          setPhase("loading")
          setStatusText(`观察中断，正在重新加载（${restarts}/2）`)
          launchWorker()
        }
        workerFailureRef.current = recover
        worker.addEventListener("error", recover)
        worker.addEventListener("messageerror", recover)
        worker.addEventListener(
          "message",
          (event: MessageEvent<WorkerMessage>) => {
            if (
              operationId !== startOperationRef.current ||
              workerRef.current !== worker
            )
              return
            if (event.data.type === "ready") {
              if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
              initTimeoutRef.current = null
              setObjectsReady(event.data.objectDetectorReady === true)
              setStatusText("正在同步本次观察区间")
              void (async () => {
                const cameraStateSynced = await syncCameraState(true, () => mountedRef.current && operationId === startOperationRef.current && workerRef.current === worker)
                if (!mountedRef.current || operationId !== startOperationRef.current || workerRef.current !== worker) return
                if (!cameraStateSynced) {
                  await stop("观察区间未能同步，已安全关闭本地摄像头。请检查网络后重试。")
                  return
                }
                setPhase("calibrating")
                setCalibrationWaitingForFace(true)
                setCalibrationProgress(0)
                setStatusText("等待你进入画面，识别到有效面部后再开始基线采集")
                startSampling()
              })()
              return
            }
            if (event.data.type === "observation") {
              if (event.data.frameId !== pendingFrameRef.current) return
              if (frameTimeoutRef.current) clearTimeout(frameTimeoutRef.current)
              frameTimeoutRef.current = null
              pendingFrameRef.current = null
              inferenceBusyRef.current = false
              consecutiveErrors = 0
              const previousCoverage = detectorRef.current.validCoverageMs
              const result = processObservation(
                detectorRef.current,
                event.data.observation,
                thresholdRef.current,
                {
                  faceAbsent: agreement.absenceSeconds !== null,
                  yaw: agreement.screenDirection && profile.policy.yaw,
                  pitch: false,
                },
              )
              detectorRef.current = result.state
              const deltaMs = result.state.validCoverageMs - previousCoverage
              if (event.data.observation.valid !== false) {
                lastValidAtRef.current = Date.now()
                frameTimesRef.current = [
                  ...frameTimesRef.current.filter(
                    (at) => at > Date.now() - 5_000,
                  ),
                  Date.now(),
                ]
                const times = frameTimesRef.current
                const span =
                  times.length > 1 ? times[times.length - 1] - times[0] : 0
                setActualFps(
                  span > 0
                    ? Math.round(((times.length - 1) * 10_000) / span) / 10
                    : 0,
                )
              } else {
                lastValidAtRef.current = 0
                setStatusText("画面质量不足，当前无法判断")
              }
              if (deltaMs > 0) {
                coverageTotalRef.current += deltaMs
                setCoverageMs((value) => value + deltaMs)
                coverageCallbackRef.current?.({
                  deltaMs,
                  totalMs: coverageTotalRef.current,
                  at: new Date(
                    event.data.observation.timestampMs,
                  ).toISOString(),
                })
              }
              if (!result.state.calibrated) {
                const waitingForFace =
                  result.state.calibrationStartedAtMs === null
                setCalibrationWaitingForFace(waitingForFace)
                if (waitingForFace) {
                  setCalibrationProgress(0)
                  setStatusText(
                    result.state.active?.kind === "face_absent"
                      ? "持续未在画面，已记录事件；等待你进入画面"
                      : "等待你进入画面，识别到有效面部后再开始基线采集",
                  )
                } else {
                  const elapsed =
                    event.data.observation.timestampMs -
                    result.state.calibrationStartedAtMs!
                  setCalibrationProgress(
                    Math.min(
                      99,
                      (elapsed / thresholdRef.current.calibrationMs) * 100,
                    ),
                  )
                  setStatusText(
                    observationProfile === "study_paper_v1"
                      ? "请保持平时的阅读姿势，正在建立本地基线"
                      : "请自然面向屏幕，正在采集中性姿态",
                  )
                }
              }
              if (result.effects.length) {
                effectsQueueRef.current = effectsQueueRef.current
                  .then(() => handleEffects(result.effects))
                  .catch(() => undefined)
              }
              return
            }
            if (event.data.type === "frame_error") {
              if (event.data.frameId !== pendingFrameRef.current) return
              if (frameTimeoutRef.current) clearTimeout(frameTimeoutRef.current)
              inferenceBusyRef.current = false
              pendingFrameRef.current = null
              lastValidAtRef.current = 0
              const reset = processObservation(
                detectorRef.current,
                {
                  timestampMs: Date.now(),
                  facePresent: false,
                  yaw: null,
                  pitch: null,
                  valid: false,
                },
                thresholdRef.current,
              )
              detectorRef.current = reset.state
              effectsQueueRef.current = effectsQueueRef.current
                .then(() => handleEffects(reset.effects))
                .catch(() => undefined)
              setStatusText("单帧无效，未累计观察覆盖")
              if (++consecutiveErrors >= 3) recover()
              return
            }
            if (event.data.type === "error") {
              recover()
            }
          },
        )
        initTimeoutRef.current = setTimeout(() => {
          if (
            operationId !== startOperationRef.current ||
            workerRef.current !== worker
          )
            return
          recover()
        }, VISION_MODEL_INIT_TIMEOUT_MS)
        worker.postMessage({ type: "init" })
      }
      launchWorker()
    } catch (cameraError) {
      if (!mountedRef.current || operationId !== startOperationRef.current)
        return
      const denied =
        cameraError instanceof DOMException &&
        cameraError.name === "NotAllowedError"
      setError(
        denied
          ? "你拒绝了摄像头授权。学习计时和手动复盘不会受影响。"
          : "摄像头没有成功启动，计时和手动复盘仍可使用。",
      )
      setPhase("error")
      if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
      initTimeoutRef.current = null
      workerRef.current?.terminate()
      workerRef.current = null
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }

  const injectSimulation = async (
    direction: EventDirection | null = "down",
  ) => {
    try {
      const now = Date.now()
      await events.create.mutateAsync({
        type: direction ? "head_direction_change" : "face_absent",
        direction,
        source: "simulation",
        startedAt: new Date(now - 8_000).toISOString(),
        endedAt: new Date(now).toISOString(),
      })
      toast.success("已注入一条明确标记为“模拟”的事件")
    } catch (simulationError) {
      toast.error(
        simulationError instanceof Error
          ? simulationError.message
          : "模拟事件注入失败",
      )
    }
  }

  const respondToCurrentReminder = async (response: ReminderResponse) => {
    const reminderId = pendingReminderIds[0]
    if (!reminderId) return
    try {
      await events.respondReminder.mutateAsync({ reminderId, response })
      setPendingReminderIds((current) =>
        current[0] === reminderId
          ? current.slice(1)
          : current.filter((id) => id !== reminderId),
      )
      toast.success("提醒反馈已记录")
    } catch (responseError) {
      toast.error(
        responseError instanceof Error
          ? responseError.message
          : "提醒反馈暂未保存",
      )
    }
  }

  useEffect(() => {
    if (paused && phase !== "idle" && phase !== "error") void stop()
  }, [paused, phase, stop])
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) void stop()
    }
    const identity = () => {
      void stop()
    }
    document.addEventListener("visibilitychange", hidden)
    window.addEventListener("studytrace:identity-changing", identity)
    return () => {
      document.removeEventListener("visibilitychange", hidden)
      window.removeEventListener("studytrace:identity-changing", identity)
    }
  }, [stop])

  useEffect(() => {
    if (phase !== "calibrating" && phase !== "observing") return
    const heartbeat = setInterval(() => {
      // This is a server-confirmed upper bound for observation coverage, not a
      // telemetry stream. A transient failure simply leaves the report behind
      // by at most the last successful checkpoint.
      void Promise.resolve(observationHeartbeatRef.current()).catch(
        () => undefined,
      )
    }, 60_000)
    return () => clearInterval(heartbeat)
  }, [phase])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      startOperationRef.current += 1
      if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
      if (frameTimeoutRef.current) clearTimeout(frameTimeoutRef.current)
      if (intervalRef.current) clearInterval(intervalRef.current)
      workerRef.current?.terminate()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      void effectsQueueRef.current.then(async () => {
        await finishActiveEventRef.current()
        await syncCameraStateRef.current(false)
      })
    }
  }, [])

  const showingCamera = phase !== "idle" && phase !== "error"

  return (
    <Card className="overflow-hidden border-indigo-100 bg-white/90 shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Eye className="size-5 text-indigo-700" /> 过程观察
            </CardTitle>
            <CardDescription className="mt-1">
              {profile.description} 默认仅本地处理；可选云端处理需单独授权。
            </CardDescription>
          </div>
          {experimentMode ? (
            <Badge className="bg-amber-100 text-amber-800">
              <FlaskConical /> 技术实验模式
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <ShieldCheck /> {profile.shortLabel}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!profile.cameraEnabled ? (
          <Alert className="border-indigo-100 bg-indigo-50/70 text-indigo-950">
            <CameraOff />
            <AlertTitle>此任务不使用电脑摄像头</AlertTitle>
            <AlertDescription>
              运动、户外等离开设备完成的任务，继续使用步骤、计时和复盘即可。电脑摄像头无法可靠确认你离开后的活动。
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="relative aspect-video overflow-hidden rounded-2xl bg-slate-950">
              <video
                ref={videoRef}
                data-session-id={sessionId}
                muted
                playsInline
                className="size-full -scale-x-100 object-cover"
                aria-label="仅本地显示的摄像头预览"
              />
              {!showingCamera ? (
                <div className="absolute inset-0 grid place-items-center bg-slate-950 text-center text-slate-300">
                  <div>
                    <CameraOff className="mx-auto size-8" />
                    <p className="mt-3 text-sm">画面仅在你开启后出现</p>
                  </div>
                </div>
              ) : null}
              <div className="absolute right-3 bottom-3 left-3 flex items-center justify-between rounded-xl bg-slate-950/70 px-3 py-2 text-xs text-white backdrop-blur">
                <span className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${phase === "observing" ? "bg-emerald-400" : "bg-amber-400"}`}
                  />
                  {statusText}
                </span>
                <span className="font-mono">
                  有效 {actualFps.toFixed(1)} FPS
                </span>
              </div>
            </div>
            <div
              className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500"
              aria-live="polite"
            >
              <span>有效观察覆盖 {Math.floor(coverageMs / 1_000)} 秒</span>
              <span>
                本地物体检测：{objectsReady ? "可用（人物／手机）" : "未就绪"}
              </span>
              <span>平板和具体使用行为仅由可选云端分析</span>
            </div>
            <CloudObservation
              key={sessionId}
              active={phase === "observing" && !paused}
              experimentMode={experimentMode}
              agreement={agreement}
              videoRef={videoRef}
              lastValidAtRef={lastValidAtRef}
              onCandidate={(ids) => {
                void events.refresh?.()
                if (settings?.reminders_enabled ?? true) {
                  toast("核对一下观察约定", {
                    description:
                      "连续两组采样中疑似出现约定外设备使用。请确认、解释或删除，不代表注意力判断。",
                  })
                  void events.reminder.mutateAsync(ids[0] ?? null)
                }
              }}
            />

            {phase === "calibrating" ? (
              <div>
                <div className="mb-2 flex justify-between text-xs text-slate-500">
                  <span>
                    {calibrationWaitingForFace
                      ? "等待进入画面"
                      : "中性姿态校准"}
                  </span>
                  <span>
                    {calibrationWaitingForFace
                      ? "尚未开始"
                      : `${Math.round(calibrationProgress)}%`}
                  </span>
                </div>
                <Progress
                  value={calibrationProgress}
                  aria-label="中性姿态校准进度"
                />
              </div>
            ) : null}

            {error ? (
              <Alert className="border-amber-200 bg-amber-50 text-amber-950">
                <TriangleAlert />
                <AlertTitle>视觉能力未启用</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {pendingReminderIds.length > 0 ? (
              <Alert className="border-emerald-200 bg-emerald-50 text-emerald-950">
                <Eye />
                <AlertTitle>刚才的轻提醒是否合适？</AlertTitle>
                <AlertDescription>
                  <p>
                    选择当时的实际情况。这些反馈只用于你自己的汇总，不会转换为专注分数。
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(
                      [
                        ["back_to_task", "已回到任务"],
                        ["normal_activity", "当时在正常操作"],
                        ["not_needed", "不需要提醒"],
                        ["later", "稍后处理"],
                      ] as const
                    ).map(([response, label]) => (
                      <Button
                        key={response}
                        size="sm"
                        variant="outline"
                        className="min-h-11 bg-white"
                        disabled={events.respondReminder.isPending}
                        onClick={() => void respondToCurrentReminder(response)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {showingCamera ? (
                <Button variant="outline" onClick={() => void stop()}>
                  <CameraOff />
                  {phase === "requesting" || phase === "loading"
                    ? "取消并关闭"
                    : "关闭摄像头"}
                </Button>
              ) : (
                <Button onClick={() => void start()} disabled={paused}>
                  <Camera /> 开启本地观察
                </Button>
              )}
              {experimentMode ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void injectSimulation(profile.policy.pitch ? "down" : null)
                  }
                >
                  <FlaskConical /> 注入模拟事件
                </Button>
              ) : null}
            </div>
          </>
        )}
        <p className="text-xs leading-5 text-slate-500">
          只保存事件类型、方向、起止时间、来源和你的修正。不会形成专注分数或医学判断。
        </p>
      </CardContent>
    </Card>
  )
}
