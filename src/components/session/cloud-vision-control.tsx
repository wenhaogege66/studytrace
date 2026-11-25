"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react"

import { useExperience } from "@/components/experience/experience-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { studyKeys } from "@/hooks/use-study-data"
import { getSupabase } from "@/lib/supabase/client"
import type { ObservationProfile } from "@/lib/vision/profiles"

export function captureCloudFrame(video: HTMLVideoElement): string | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight)
    return null
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Frame unavailable")
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  const image = canvas.toDataURL("image/jpeg", 0.8)
  canvas.width = canvas.height = 0
  const encoded = image.slice("data:image/jpeg;base64,".length)
  const decodedBytes =
    (encoded.length * 3) / 4 -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
  if (!image.startsWith("data:image/jpeg;base64,") || decodedBytes > 256 * 1024)
    throw new Error("Frame too large")
  return image
}

async function postVision(
  endpoint: "consent" | "observe",
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const { data, error } = await getSupabase().auth.getSession()
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  if (error || !data.session) throw new Error("Authentication required")
  const response = await fetch(`/api/vision/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
    keepalive: endpoint === "consent" && body.enabled === false,
  })
  if (!response.ok) throw new Error("Cloud observation unavailable")
  return response.json()
}

export function CloudVisionControl({
  sessionId,
  paused,
  observationProfile,
  cameraActive,
  capture,
  stopRef,
}: {
  sessionId: string
  paused: boolean
  observationProfile: ObservationProfile
  cameraActive: boolean
  capture: () => string | null
  stopRef: MutableRefObject<() => void>
}) {
  const { user } = useExperience()
  const userId = user?.id
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [checked, setChecked] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState(false)
  const captureRef = useRef(capture)
  const enableRef = useRef<() => Promise<void>>(async () => {})
  const busyRef = useRef(false)
  const pendingRef = useRef(false)
  const revocationRef = useRef<Promise<void> | null>(null)
  const lastCompletionRef = useRef(-Infinity)
  const eligible =
    Boolean(user) &&
    !paused &&
    cameraActive &&
    observationProfile !== "off_device_v1"

  useLayoutEffect(() => {
    captureRef.current = capture
  }, [capture])

  useLayoutEffect(() => {
    let live = true
    let generation = 0
    let grant: string | null = null
    let granting = false
    let revocationRequested = false
    let timer: ReturnType<typeof setInterval> | undefined
    let request: AbortController | undefined
    const hidden = () => document.visibilityState === "hidden"

    const revoke = () => {
      setRevoking(true)
      const previous = revocationRef.current ?? Promise.resolve()
      const operation = previous
        .then(() => postVision("consent", { sessionId, enabled: false }))
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          if (revocationRef.current === operation) {
            revocationRef.current = null
            setRevoking(false)
          }
        })
      revocationRef.current = operation
      return operation
    }
    const stop = () => {
      generation += 1
      if (timer) clearInterval(timer)
      timer = undefined
      request?.abort()
      if ((grant || granting) && !revocationRequested) {
        revocationRequested = true
        void revoke()
      }
      grant = null
      setEnabled(false)
      setDialogOpen(false)
      setChecked(false)
    }
    const sample = async () => {
      if (
        !live ||
        !eligible ||
        !grant ||
        hidden() ||
        busyRef.current ||
        Date.now() - lastCompletionRef.current < 30_000
      )
        return
      busyRef.current = true
      const currentGeneration = generation
      const controller = new AbortController()
      request = controller
      let attempted = false
      try {
        const image = captureRef.current()
        if (!image) return
        attempted = true
        await postVision(
          "observe",
          { sessionId, consentToken: grant, image },
          controller.signal,
        )
        if (
          live &&
          generation === currentGeneration &&
          !controller.signal.aborted
        )
          void queryClient.invalidateQueries({
            queryKey: studyKeys.events(userId!, sessionId),
          })
      } catch {
        if (
          live &&
          generation === currentGeneration &&
          !controller.signal.aborted
        ) {
          stop()
          setError(true)
        }
      } finally {
        // Include auth/network time, even if cancellation changed the generation.
        if (attempted) lastCompletionRef.current = Date.now()
        busyRef.current = false
        if (request === controller) request = undefined
      }
    }
    enableRef.current = async () => {
      if (
        !live ||
        !eligible ||
        pendingRef.current ||
        revocationRef.current ||
        hidden()
      )
        return
      const currentGeneration = generation
      pendingRef.current = true
      granting = true
      revocationRequested = false
      setPending(true)
      setError(false)
      setDialogOpen(false)
      setChecked(false)
      try {
        // Let consent settle so a cancelled late grant can be revoked in order.
        const result = await postVision("consent", { sessionId, enabled: true })
        if (!live || generation !== currentGeneration || hidden()) {
          await revoke()
          return
        }
        if (typeof result.consentToken !== "string")
          throw new Error("Missing consent")
        grant = result.consentToken
        setEnabled(true)
        timer = setInterval(() => void sample(), 30_000)
        void sample()
      } catch {
        await revoke()
        if (live && generation === currentGeneration) {
          stop()
          setError(true)
        }
      } finally {
        granting = false
        pendingRef.current = false
        setPending(false)
      }
    }
    stopRef.current = stop
    const visibilityChanged = () => {
      if (hidden()) stop()
    }
    document.addEventListener("visibilitychange", visibilityChanged)
    window.addEventListener("pagehide", stop)
    return () => {
      live = false
      stop()
      document.removeEventListener("visibilitychange", visibilityChanged)
      window.removeEventListener("pagehide", stop)
    }
  }, [eligible, queryClient, sessionId, stopRef, userId])

  return (
    <div className="space-y-2 rounded-xl border border-indigo-100 p-3">
      <p className="text-sm font-medium">可选云端观察</p>
      <p className="text-xs text-slate-500">
        默认只在本地观察。云端是单帧线索，不确定，不推断持续时间或专注程度。
      </p>
      {enabled || pending ? (
        <Button variant="outline" onClick={() => stopRef.current()}>
          关闭云端观察
        </Button>
      ) : (
        <Button
          variant="outline"
          disabled={!eligible || pending || revoking}
          onClick={() => {
            setChecked(false)
            setDialogOpen(true)
          }}
        >
          开启云端观察
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-xs text-amber-800">
          云端观察失败，已停用。本地观察仍可继续；再次开启需要重新同意。
        </p>
      ) : null}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          setChecked(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>同意本次云端观察？</DialogTitle>
            <DialogDescription>
              每 30
              秒最多发送一张摄像头抽样画面和当前任务给云端模型，不采集桌面或屏幕共享。
              应用不保存原始图片；云端服务商会接收画面，其数据处理遵循服务商政策。
              暂停、关闭摄像头、隐藏或离开页面会撤销本次授权，恢复需重新确认。
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            同意将抽样画面和当前任务发送给云端模型
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!checked || !eligible || pending || revoking}
              onClick={() => void enableRef.current()}
            >
              确认开启
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
