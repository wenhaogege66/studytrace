"use client"

import { useEffect, useRef } from "react"

import { useExperience } from "@/components/experience/experience-provider"
import { touchMyActivity } from "@/lib/auth/account-repository"

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

export function ActivityHeartbeat() {
  const { status, user } = useExperience()
  const lastTouchRef = useRef(0)

  useEffect(() => {
    if (status !== "ready" || !user) return
    lastTouchRef.current = 0

    const touch = () => {
      if (
        document.visibilityState !== "visible" ||
        Date.now() - lastTouchRef.current < HEARTBEAT_INTERVAL_MS
      ) {
        return
      }
      lastTouchRef.current = Date.now()
      void touchMyActivity().catch(() => {
        // Retention heartbeats are best-effort and must never interrupt study.
        lastTouchRef.current = 0
      })
    }

    touch()
    document.addEventListener("visibilitychange", touch)
    const timer = window.setInterval(touch, HEARTBEAT_INTERVAL_MS)
    return () => {
      document.removeEventListener("visibilitychange", touch)
      window.clearInterval(timer)
    }
  }, [status, user])

  return null
}
