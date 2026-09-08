"use client"

import { useEffect, useRef } from "react"

export const SESSION_CHECKPOINT_INTERVAL_MS = 60_000

type CheckpointHeartbeatOptions = {
  enabled?: boolean
  runImmediately?: boolean
}

/**
 * Keeps the scheduling effect stable while the caller re-renders every second.
 * The latest callback is read from a ref, and callback failures remain local so
 * a temporary network problem never interrupts the visible timer.
 */
export function useCheckpointHeartbeat(
  checkpoint: () => Promise<void> | void,
  { enabled = true, runImmediately = false }: CheckpointHeartbeatOptions = {},
) {
  const checkpointRef = useRef(checkpoint)

  useEffect(() => {
    checkpointRef.current = checkpoint
  }, [checkpoint])

  useEffect(() => {
    if (!enabled) return
    const run = () => {
      void Promise.resolve(checkpointRef.current()).catch(() => undefined)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") run()
    }
    if (runImmediately) run()
    const heartbeat = setInterval(run, SESSION_CHECKPOINT_INTERVAL_MS)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      clearInterval(heartbeat)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [enabled, runImmediately])
}
