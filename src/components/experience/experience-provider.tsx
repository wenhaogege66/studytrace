"use client"

import type { User } from "@supabase/supabase-js"
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { ensureSettings } from "@/lib/data/study-repository"
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase/client"

type ExperienceStatus =
  "checking" | "needs_gate" | "starting" | "ready" | "error"

type ExperienceContextValue = {
  status: ExperienceStatus
  user: User | null
  error: string | null
  begin: (captchaToken?: string) => Promise<void>
  retry: () => void
}

const ExperienceContext = createContext<ExperienceContextValue | null>(null)
const subscribeToHydration = () => () => undefined

export function ExperienceProvider({ children }: { children: ReactNode }) {
  const configured = hasSupabaseConfig()
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  )
  const [status, setStatus] = useState<ExperienceStatus>("checking")
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkVersion, setCheckVersion] = useState(0)
  const beginPromiseRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    let active = true

    if (!mounted) return
    if (!configured) return

    const supabase = getSupabase()
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return
      if (sessionError) {
        setError(sessionError.message)
        setStatus("error")
        return
      }
      setUser(data.session?.user ?? null)
      setStatus(data.session?.user ? "ready" : "needs_gate")
    })

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!active) return
        setUser(session?.user ?? null)
        setError(null)
        setStatus(session?.user ? "ready" : "needs_gate")
      },
    )

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [checkVersion, configured, mounted])

  const begin = useCallback(async (captchaToken?: string) => {
    if (beginPromiseRef.current) return beginPromiseRef.current

    const operation = (async () => {
      setStatus("starting")
      setError(null)
      const supabase = getSupabase()
      const options = captchaToken ? { options: { captchaToken } } : undefined
      const { data, error: signInError } =
        await supabase.auth.signInAnonymously(options)
      if (signInError || !data.user) {
        setError(signInError?.message ?? "无法创建匿名体验")
        setStatus("needs_gate")
        throw signInError ?? new Error("无法创建匿名体验")
      }

      await ensureSettings(data.user.id)
      setUser(data.user)
      setStatus("ready")
    })()

    beginPromiseRef.current = operation
    try {
      await operation
    } finally {
      if (beginPromiseRef.current === operation) beginPromiseRef.current = null
    }
  }, [])

  const value = useMemo<ExperienceContextValue>(
    () => ({
      status: !mounted ? "checking" : configured ? status : "error",
      user,
      error:
        mounted && !configured
          ? "体验环境尚未配置，请检查公开 Supabase 环境变量。"
          : error,
      begin,
      retry: () => {
        setStatus("checking")
        setError(null)
        setCheckVersion((version) => version + 1)
      },
    }),
    [begin, configured, error, mounted, status, user],
  )

  return <ExperienceContext value={value}>{children}</ExperienceContext>
}

export function useExperience() {
  const value = use(ExperienceContext)
  if (!value)
    throw new Error("useExperience must be used inside ExperienceProvider")
  return value
}
