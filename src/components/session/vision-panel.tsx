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
  | { type: "ready" }
  | { type: "observation"; observation: VisionObservation }
  | { type: "error" | "frame_error"; message: string }
  | { type: "stopped" }

type VisionPhase =
  "idle" | "requesting" | "loading" | "calibrating" | "observing" | "error"

export const VISION_MODEL_INIT_TIMEOUT_MS = 20_000
const EVENT_CLOSE_RETRY_DELAYS_MS = [0, 150, 500] as const

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
  onCameraStateChange,
}: {
  sessionId: string
  paused: boolean
  experimentMode: boolean
  observationProfile: ObservationProfile
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
  onCameraStateChange: (enabled: boolean) => void
}) {
  const profile = getObservationProfile(observationProfile)
  const events = useEventMutations(sessionId)
  const [phase, setPhase] = useState<VisionPhase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [statusText, setStatusText] = useState("摄像头未开启")
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  const [calibrationWaitingForFace, setCalibrationWaitingForFace] =
    useState(true)
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

  const thresholds: VisionThresholds = useMemo(
    () =>
      experimentMode
        ? EXPERIMENT_THRESHOLDS
        : {
            ...DEFAULT_THRESHOLDS,
            calibrationMs: (settings?.calibration_seconds ?? 3) * 1_000,
            faceAbsentMs:
              (settings?.face_absent_seconds ?? 5) *
              1_000 *
              profile.faceAbsentMultiplier,
            directionHoldMs: (settings?.direction_hold_seconds ?? 3) * 1_000,
            neutralRecoveryMs:
              (settings?.neutral_recovery_seconds ?? 1) * 1_000,
            reminderDelayMs: (settings?.reminder_delay_seconds ?? 15) * 1_000,
            reminderCooldownMs:
              (settings?.reminder_cooldown_seconds ?? 600) * 1_000,
            yawDegrees: settings?.yaw_threshold_degrees ?? 25,
            pitchDegrees: settings?.pitch_threshold_degrees ?? 20,
          },
    [experimentMode, profile.faceAbsentMultiplier, settings],
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

  const stop = useCallback(
    async (failureMessage?: string) => {
      if (stoppingRef.current) return
      stoppingRef.current = true
      try {
        startOperationRef.current += 1
        if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
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
        const eventClosed = await finishActiveEvent()
        inferenceBusyRef.current = false
        detectorRef.current = createDetectorState()
        if (mountedRef.current) {
          if (!eventClosed)
            toast.error("观察事件结束时间暂未同步，下次关闭时会继续重试")
          setPhase(failureMessage ? "error" : "idle")
          setError(failureMessage ?? null)
          setStatusText(
            failureMessage ? "本地视觉已停止" : "摄像头已关闭，本地推理已停止",
          )
          setCalibrationProgress(0)
          setCalibrationWaitingForFace(true)
          onCameraStateChange(false)
        }
      } finally {
        stoppingRef.current = false
      }
    },
    [finishActiveEvent, onCameraStateChange],
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
          await events.reminder.mutateAsync(activeEventIdRef.current)
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
    const fps = Math.max(1, Math.min(10, settings?.sample_fps ?? 4))
    intervalRef.current = setInterval(
      () => {
        void (async () => {
          const video = videoRef.current
          const worker = workerRef.current
          if (
            !video ||
            !worker ||
            inferenceBusyRef.current ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
          )
            return
          inferenceBusyRef.current = true
          try {
            const bitmap = await createImageBitmap(video)
            worker.postMessage(
              {
                type: "detect",
                bitmap,
                timestampMs: performance.timeOrigin + performance.now(),
              },
              [bitmap],
            )
          } catch {
            inferenceBusyRef.current = false
          }
        })()
      },
      Math.round(1_000 / fps),
    )
  }, [settings?.sample_fps])

  const start = async () => {
    if (stoppingRef.current) return
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
      const worker = new Worker(
        new URL("../../workers/vision.worker.ts", import.meta.url),
        { type: "module" },
      )
      workerRef.current = worker
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
            setPhase("calibrating")
            setCalibrationWaitingForFace(true)
            setCalibrationProgress(0)
            setStatusText("等待你进入画面，识别到有效面部后再开始基线采集")
            onCameraStateChange(true)
            startSampling()
            return
          }
          if (event.data.type === "observation") {
            inferenceBusyRef.current = false
            const result = processObservation(
              detectorRef.current,
              event.data.observation,
              thresholdRef.current,
              profile.policy,
            )
            detectorRef.current = result.state
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
            inferenceBusyRef.current = false
            return
          }
          if (event.data.type === "error") {
            void stop(`${event.data.message}。计时与手动复盘仍可继续。`)
          }
        },
      )
      initTimeoutRef.current = setTimeout(() => {
        if (
          operationId !== startOperationRef.current ||
          workerRef.current !== worker
        )
          return
        void stop("视觉模型加载超时，已关闭摄像头。计时与手动复盘仍可继续。")
      }, VISION_MODEL_INIT_TIMEOUT_MS)
      worker.postMessage({ type: "init" })
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

  useEffect(() => {
    if (paused && phase !== "idle" && phase !== "error") void stop()
  }, [paused, phase, stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      startOperationRef.current += 1
      if (initTimeoutRef.current) clearTimeout(initTimeoutRef.current)
      if (intervalRef.current) clearInterval(intervalRef.current)
      workerRef.current?.terminate()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      void effectsQueueRef.current.then(() => finishActiveEventRef.current())
    }
  }, [])

  const showingCamera = phase !== "idle" && phase !== "error"

  return (
    <Card className="overflow-hidden border-indigo-100 bg-white/90 shadow-sm">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Eye className="size-5 text-indigo-700" /> 场景化本地观察
            </CardTitle>
            <CardDescription className="mt-1">
              {profile.description} 原始画面不会上传。
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
                  {settings?.sample_fps ?? 4} FPS
                </span>
              </div>
            </div>

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
                <Progress value={calibrationProgress} />
              </div>
            ) : null}

            {error ? (
              <Alert className="border-amber-200 bg-amber-50 text-amber-950">
                <TriangleAlert />
                <AlertTitle>视觉能力未启用</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
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
