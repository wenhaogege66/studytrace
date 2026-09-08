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
import {
  getSupabase,
  hasSupabaseConfig,
  withSupabaseAuthMutationLock,
} from "@/lib/supabase/client"

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

function isDefinitivelyMissingAuthUser(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? String(error.code ?? "") : ""
  const status = "status" in error ? Number(error.status) : 0
  const message = error.message.toLocaleLowerCase("en-US")
  return (
    code === "user_not_found" ||
    ((status === 401 || status === 403 || status === 404) &&
      (message.includes("user from sub claim") ||
        message.includes("user does not exist") ||
        message.includes("user not found")))
  )
}

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
    let validationVersion = 0
    let clearingStaleSession = false

    if (!mounted) return
    if (!configured) return

    const supabase = getSupabase()
    const validateStoredSession = async (showChecking = false) => {
      const currentValidation = ++validationVersion
      if (showChecking) setStatus("checking")

      const { data, error: sessionError } = await supabase.auth.getSession()
      if (!active || currentValidation !== validationVersion) return
      if (sessionError) {
        setUser(null)
        setError(sessionError.message)
        setStatus("error")
        return
      }

      const cachedUser = data.session?.user ?? null
      if (!cachedUser) {
        setUser(null)
        setError(null)
        setStatus("needs_gate")
        return
      }

      const { data: verified, error: verificationError } =
        await supabase.auth.getUser()
      if (!active || currentValidation !== validationVersion) return
      if (verificationError) {
        if (!isDefinitivelyMissingAuthUser(verificationError)) {
          setUser(null)
          setError(verificationError.message)
          setStatus("error")
          return
        }

        const staleSessionMessage =
          "上次身份已失效。若刚完成记录合并，请通过邮箱验证恢复；否则可重新开始匿名体验。"
        try {
          const cleanupResult = await withSupabaseAuthMutationLock(
            async (): Promise<"changed" | "cleared" | "valid"> => {
              const { data: live, error: liveSessionError } =
                await supabase.auth.getSession()
              if (liveSessionError) throw liveSessionError
              if (live.session?.user.id !== cachedUser.id) return "changed"

              // The session may have changed while this tab waited for the
              // cross-tab lock. Reconfirm the deletion inside the same lock
              // before clearing anything from shared auth storage.
              const { data: liveUser, error: liveVerificationError } =
                await supabase.auth.getUser()
              if (!liveVerificationError && liveUser.user?.id === cachedUser.id)
                return "valid"
              if (!isDefinitivelyMissingAuthUser(liveVerificationError)) {
                throw (
                  liveVerificationError ??
                  new Error("本地身份与服务器不一致，请重试后再继续。")
                )
              }

              clearingStaleSession = true
              try {
                await supabase.auth.signOut({ scope: "local" })
              } finally {
                clearingStaleSession = false
              }
              return "cleared"
            },
          )

          if (!active) return
          if (cleanupResult === "changed") {
            void validateStoredSession()
            return
          }
          if (cleanupResult === "valid") {
            void validateStoredSession()
            return
          }

          setUser(null)
          setError(staleSessionMessage)
          setStatus("needs_gate")
        } catch (cleanupError) {
          if (!active) return
          setUser(null)
          setError(
            cleanupError instanceof Error
              ? cleanupError.message
              : "身份状态暂时无法确认，请重试。",
          )
          setStatus("error")
        }
        return
      }

      if (!verified.user || verified.user.id !== cachedUser.id) {
        setUser(null)
        setError("本地身份与服务器不一致，请重试后再继续。")
        setStatus("error")
        return
      }

      setUser(verified.user)
      setError(null)
      setStatus("ready")
    }

    void validateStoredSession(true)

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!active) return
        if (event === "SIGNED_OUT" || !session) {
          validationVersion += 1
          setUser(null)
          if (!clearingStaleSession) setError(null)
          setStatus("needs_gate")
          return
        }

        // Auth events are broadcast across tabs. Validate the live server user
        // before exposing application data instead of trusting cached JWT data.
        void validateStoredSession()
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
      const { data, error: signInError } = await withSupabaseAuthMutationLock(
        () => supabase.auth.signInAnonymously(options),
      )
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
