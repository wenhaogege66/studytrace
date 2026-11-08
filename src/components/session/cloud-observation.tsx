"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  getMyConsents,
  hasConsent,
  setMyConsent,
  type UserConsents,
} from "@/lib/privacy/consents"
import { getSupabase } from "@/lib/supabase/client"
import type { ObservationAgreement } from "@/lib/vision/agreement"

type Frame = { image: string; capturedAt: string }
export function CloudObservation({
  active,
  experimentMode,
  agreement,
  videoRef,
  lastValidAtRef,
  onCandidate,
  userId,
}: {
  active: boolean
  experimentMode: boolean
  agreement: ObservationAgreement
  videoRef: RefObject<HTMLVideoElement | null>
  lastValidAtRef: RefObject<number>
  onCandidate: (eventIds: string[], reminderIds: string[]) => void
  userId?: string
}) {
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState("未启用，不会发送摄像头画面")
  const [error, setError] = useState<string | null>(null)
  const [cycle, setCycle] = useState(0)
  const candidateRef = useRef(onCandidate)
  useEffect(() => {
    candidateRef.current = onCandidate
  }, [onCandidate])
  const abortRef = useRef<AbortController | null>(null)
  const lastRequestAtRef = useRef<number | null>(null)
  const stopUploads = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])
  useEffect(() => {
    const changed = (event: Event) => {
      const consents = (event as CustomEvent<UserConsents>).detail
      if (!hasConsent(consents, "cloud_observation")) {
        stopUploads()
        setEnabled(false)
        setStatus("授权已撤回，不再发送图像")
      }
    }
    const identity = () => {
      stopUploads()
      setEnabled(false)
    }
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("studytrace:consents")
        : null
    if (channel)
      channel.onmessage = (
        event: MessageEvent<{ userId: string; consents: UserConsents }>,
      ) => {
        if (
          (!userId || event.data.userId === userId) &&
          !hasConsent(event.data.consents, "cloud_observation")
        ) {
          stopUploads()
          setEnabled(false)
          setStatus("其他页面已撤回授权，不再发送图像")
        }
      }
    window.addEventListener("studytrace:consent-changed", changed)
    window.addEventListener("studytrace:identity-changing", identity)
    window.addEventListener("studytrace:observation-stopping", stopUploads)
    return () => {
      window.removeEventListener("studytrace:consent-changed", changed)
      window.removeEventListener("studytrace:identity-changing", identity)
      window.removeEventListener("studytrace:observation-stopping", stopUploads)
      stopUploads()
      channel?.close()
    }
  }, [stopUploads, userId])

  useEffect(() => {
    if (
      !active ||
      !enabled ||
      experimentMode ||
      (agreement.phone !== "restricted" && agreement.tablet !== "restricted")
    ) {
      lastRequestAtRef.current = null
      return
    }
    let cancelled = false
    let frames: Frame[] = []
    lastRequestAtRef.current ??= Date.now()
    const canvas = document.createElement("canvas")
    canvas.width = 480
    canvas.height = 360
    const context = canvas.getContext("2d")
    const controller = new AbortController()
    abortRef.current = controller
    const clear = () => {
      cancelled = true
      frames = []
      controller.abort()
      canvas.width = 0
      canvas.height = 0
    }
    const visibility = () => {
      if (document.hidden) clear()
    }
    document.addEventListener("visibilitychange", visibility)
    const interval = setInterval(() => {
      void (async () => {
        if (cancelled || document.hidden || controller.signal.aborted) return
        const video = videoRef.current
        if (
          !context ||
          !video ||
          video.readyState < 2 ||
          Date.now() - lastValidAtRef.current > 1_000
        ) {
          frames = []
          setStatus("画面质量或有效采样不足，暂不上传")
          return
        }
        const scale = Math.min(
          480 / (video.videoWidth || 640),
          360 / (video.videoHeight || 480),
        )
        canvas.width = Math.round((video.videoWidth || 640) * scale)
        canvas.height = Math.round((video.videoHeight || 480) * scale)
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = canvas.toDataURL("image/jpeg", 0.55)
        if (image.length > 180_000) {
          frames = []
          setStatus("画面压缩失败，暂不上传")
          return
        }
        frames.push({ image, capturedAt: new Date().toISOString() })
        frames = frames.slice(-4)
        if (
          frames.length < 4 ||
          Date.now() - (lastRequestAtRef.current ?? Date.now()) < 20_000 ||
          abortRef.current !== controller
        )
          return
        if (
          Number(Date.parse(frames[3].capturedAt)) -
            Date.parse(frames[0].capturedAt) >
          8_000
        ) {
          frames = []
          return
        }
        lastRequestAtRef.current = Date.now()
        const selected = frames
        frames = []
        // Hold no additional frame group while a request is in flight.
        setStatus("云端正在处理本组四张图像")
        clearInterval(interval)
        const requestTimeout = setTimeout(() => {
          if (cancelled) return
          controller.abort()
          setEnabled(false)
          setError("云端处理超时，已停止上传；本地观察继续")
        }, 18_000)
        try {
          const { data } = await Promise.race([
            getSupabase().auth.getSession(),
            new Promise<never>((_resolve, reject) =>
              controller.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Cancelled", "AbortError")),
                { once: true },
              ),
            ),
          ])
          if (
            !data.session ||
            (userId && data.session.user.id !== userId) ||
            cancelled ||
            document.hidden
          )
            return
          const sessionId = video.dataset.sessionId
          const response = await fetch("/api/observation/analyze", {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${data.session.access_token}`,
            },
            body: JSON.stringify({
              sessionId,
              windowId: crypto.randomUUID(),
              frames: selected,
            }),
          })
          const result = (await response.json()) as {
            error?: string
            status?: string
            quality?: string
            candidate_event_ids?: string[]
            reminder_event_ids?: string[]
          }
          if (cancelled || document.hidden || controller.signal.aborted) return
          if (!response.ok) {
            setError(result.error ?? "云端连接暂不可用")
            setStatus("云端已停止；本地观察继续")
            setEnabled(false)
            return
          }
          setStatus(
            result.status === "discarded"
              ? "本组已失效，不产生提醒"
              : result.quality === "unknown"
                ? "本组无法判断，等待下一次有效采样"
                : "本组分析完成，仅记录可见线索",
          )
          if (result.candidate_event_ids?.length)
            candidateRef.current(
              result.candidate_event_ids,
              result.reminder_event_ids ?? [],
            )
        } catch {
          if (!controller.signal.aborted && !cancelled) {
            setError("云端网络不可用，本地观察继续")
            setEnabled(false)
          }
        } finally {
          clearTimeout(requestTimeout)
          selected.length = 0
          // Restart the lifecycle through a state tick, with a new abort token.
          if (!cancelled && !controller.signal.aborted)
            setCycle((value) => value + 1)
        }
      })()
    }, 2_000)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", visibility)
      clear()
      if (abortRef.current === controller) abortRef.current = null
    }
    // cycle creates a fresh finite request lifecycle; no images escape this scope.
  }, [
    active,
    enabled,
    experimentMode,
    agreement.phone,
    agreement.tablet,
    videoRef,
    lastValidAtRef,
    cycle,
    userId,
  ])

  const change = async (checked: boolean) => {
    if (!checked) {
      stopUploads()
      setEnabled(false)
      setStatus("已关闭，不再发送图像")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const consents = await getMyConsents(userId)
      if (!hasConsent(consents, "cloud_observation"))
        await setMyConsent("cloud_observation", true, userId)
      setEnabled(true)
      setStatus("云端已待命：每二十秒一组四张压缩图像")
    } catch {
      setError("授权保存失败，云端未开启，本地观察仍可使用")
    } finally {
      setSaving(false)
    }
  }
  const available =
    agreement.phone === "restricted" || agreement.tablet === "restricted"
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <Checkbox
          id="cloud-process-observation"
          checked={enabled}
          disabled={saving || experimentMode || !available}
          onCheckedChange={(value) => void change(value === true)}
          className="mt-1"
        />
        <Label htmlFor="cloud-process-observation" className="block leading-6">
          本次同时启用云端过程观察（可选）
          <span className="mt-1 block text-xs leading-5 font-normal text-slate-600">
            只检查已约定不使用的手机或平板。每二十秒向阿里云百炼发送覆盖约六秒的四张压缩图像，不发送音频；本应用不保存画面。百炼说明会依法存储模型调用产生的数据，第三方按其服务条款处理，不能承诺第三方零留存。
          </span>
        </Label>
      </div>
      {!available ? (
        <p className="mt-2 text-xs text-slate-500">
          当前没有设备限制约定，无需云端图像分析。
        </p>
      ) : null}
      {experimentMode ? (
        <p className="mt-2 text-xs text-amber-800">
          技术实验模式不发送真实图像。
        </p>
      ) : null}
      <p className="mt-2 text-xs text-slate-600" role="status">
        {enabled && !active ? "等待摄像头模型就绪后才开始采样" : status}
      </p>
      {error ? (
        <p className="mt-2 text-xs text-amber-900" role="alert">
          {error}
        </p>
      ) : null}
      <a
        className="mt-2 inline-block text-xs text-indigo-700 underline underline-offset-4"
        href="https://help.aliyun.com/zh/model-studio/privacy-notice"
        target="_blank"
        rel="noreferrer"
      >
        百炼数据处理说明
      </a>
    </div>
  )
}
