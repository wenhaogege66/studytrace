"use client"

import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  Cloud,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TurnstileChallenge } from "@/components/auth/turnstile-challenge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ACCOUNT_FLOW_STORAGE_KEY,
  ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY,
  ACCOUNT_MERGE_HANDOFF_MARKER_KEY,
  ACCOUNT_MERGE_RECOVERY_STORAGE_KEY,
  OTP_RESEND_SECONDS,
  friendlyAccountError,
  maskEmail,
  normalizeEmail,
  normalizeOtp,
  parseAccountMergeDurableFlow,
  parseAccountMergeHandoffMarker,
  parseAnonymousMergeRecovery,
  parsePendingAccountFlow,
  pendingMergeFromDurableFlow,
  serializeAnonymousMergeRecovery,
  serializeAccountMergeDurableFlow,
  serializeAccountMergeHandoffMarker,
  serializePendingAccountFlow,
  type AccountMergeRecovery,
  type AccountMergeDurableFlow,
  type AccountMergeHandoffMarker,
  type AccountMergeResult,
  type AccountTransferSummary,
  type PendingAccountFlow,
} from "@/lib/auth/account"
import {
  beginEmailAccountFlow,
  cancelPendingAccountFlow,
  clearDefinitivelyStaleAuthSession,
  confirmAccountMerge,
  createPreparedAccountDeletionFlow,
  createPreparedAccountMergeFlow,
  getAccountTransferSummary,
  isDefinitiveAccountRpcRollback,
  isDefinitivelyMissingAuthUser,
  isMergeResultUncertain,
  isMergeSourceRestored,
  isMergeTargetReverificationRequired,
  requestAccountDeletionOtp,
  resendAccountOtp,
  resumePendingAccountFlow,
  signOutSafely,
  touchMyActivity,
  verifyAccountOtp,
  verifyAndDeleteAccount,
} from "@/lib/auth/account-repository"
import {
  getSupabase,
  hasSupabaseConfig,
  withAccountMergeStorageLock,
  withSupabaseAuthMutationLock,
} from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"

const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
const supabaseConfigured = hasSupabaseConfig()
const missingSupabaseMessage = "体验环境尚未配置 Supabase 公开变量。"
const legacyDurableMergeFlowKey = "studytrace.pending-account-merge-durable.v1"

function savePendingFlow(flow: PendingAccountFlow | null) {
  if (flow) {
    sessionStorage.setItem(
      ACCOUNT_FLOW_STORAGE_KEY,
      serializePendingAccountFlow(flow),
    )
  } else {
    sessionStorage.removeItem(ACCOUNT_FLOW_STORAGE_KEY)
  }
}

function saveMergeRecovery(recovery: AccountMergeRecovery | null) {
  if (recovery) {
    sessionStorage.setItem(
      ACCOUNT_MERGE_RECOVERY_STORAGE_KEY,
      serializeAnonymousMergeRecovery(recovery),
    )
  } else {
    sessionStorage.removeItem(ACCOUNT_MERGE_RECOVERY_STORAGE_KEY)
  }
}

function saveMergeHandoffMarker(marker: AccountMergeHandoffMarker | null) {
  if (marker) {
    localStorage.setItem(
      ACCOUNT_MERGE_HANDOFF_MARKER_KEY,
      serializeAccountMergeHandoffMarker(marker),
    )
  } else {
    localStorage.removeItem(ACCOUNT_MERGE_HANDOFF_MARKER_KEY)
  }
}

function saveDurableMergeFlow(flow: AccountMergeDurableFlow | null) {
  if (flow) {
    localStorage.setItem(
      ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY,
      serializeAccountMergeDurableFlow(flow),
    )
  } else {
    localStorage.removeItem(ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY)
  }
}

function durableMatchesFlow(
  durable: AccountMergeDurableFlow | null,
  flow: PendingAccountFlow,
): durable is AccountMergeDurableFlow {
  return Boolean(
    durable &&
    flow.kind === "merge" &&
    durable.sourceUserId === flow.sourceUserId &&
    durable.email === flow.email &&
    durable.mergeSecret === flow.mergeSecret &&
    durable.preparedAt === flow.preparedAt,
  )
}

function storedDurableMatchesFlow(
  value: string | null,
  flow: PendingAccountFlow,
) {
  if (!value || flow.kind !== "merge") return false
  try {
    const durable = JSON.parse(value) as Partial<AccountMergeDurableFlow>
    return (
      durable.sourceUserId === flow.sourceUserId &&
      durable.email === flow.email &&
      durable.mergeSecret === flow.mergeSecret &&
      durable.preparedAt === flow.preparedAt
    )
  } catch {
    return false
  }
}

function storedMarkerMatchesFlow(
  value: string | null,
  flow: PendingAccountFlow,
) {
  if (!value || flow.kind !== "merge") return false
  try {
    const marker = JSON.parse(value) as Partial<AccountMergeHandoffMarker>
    return (
      marker.sourceUserId === flow.sourceUserId &&
      marker.email === flow.email &&
      marker.capturedAt === flow.preparedAt
    )
  } catch {
    return false
  }
}

async function claimDurableMergeFlow(candidate: PendingAccountFlow) {
  return withAccountMergeStorageLock(() => {
    const existing = parseAccountMergeDurableFlow(
      localStorage.getItem(ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY),
    )
    if (
      existing &&
      (existing.sourceUserId !== candidate.sourceUserId ||
        existing.email !== candidate.email)
    ) {
      throw new Error(
        "当前浏览器已有另一项记录合并正在确认，请先返回原页面处理。",
      )
    }
    const preparedFlow = existing
      ? pendingMergeFromDurableFlow(existing)
      : candidate
    if (
      preparedFlow.kind !== "merge" ||
      !preparedFlow.sourceUserId ||
      !preparedFlow.mergeSecret ||
      !preparedFlow.preparedAt
    ) {
      throw new Error("记录合并准备状态不完整")
    }
    saveDurableMergeFlow({
      sourceUserId: preparedFlow.sourceUserId,
      ...(preparedFlow.mergeTargetUserId
        ? { targetUserId: preparedFlow.mergeTargetUserId }
        : {}),
      email: preparedFlow.email,
      mergeSecret: preparedFlow.mergeSecret,
      preparedAt: preparedFlow.preparedAt,
    })
    saveMergeHandoffMarker({
      sourceUserId: preparedFlow.sourceUserId,
      ...(preparedFlow.mergeTargetUserId
        ? { targetUserId: preparedFlow.mergeTargetUserId }
        : {}),
      email: preparedFlow.email,
      capturedAt: preparedFlow.preparedAt,
    })
    return preparedFlow
  })
}

async function attachTargetToDurableMerge(
  flow: PendingAccountFlow,
  recovery: AccountMergeRecovery,
) {
  await withAccountMergeStorageLock(() => {
    const current = parseAccountMergeDurableFlow(
      localStorage.getItem(ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY),
    )
    if (!durableMatchesFlow(current, flow)) {
      throw new Error(
        "记录合并流程已在其他标签页改变，本次验证码不会继续消费旧凭证。",
      )
    }
    saveDurableMergeFlow({
      ...current,
      targetUserId: recovery.targetUserId,
    })
    saveMergeHandoffMarker({
      sourceUserId: current.sourceUserId,
      targetUserId: recovery.targetUserId,
      email: current.email,
      capturedAt: current.preparedAt,
    })
  })
}

async function assertDurableMergeFlowCurrent(flow: PendingAccountFlow) {
  await withAccountMergeStorageLock(() => {
    const current = parseAccountMergeDurableFlow(
      localStorage.getItem(ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY),
    )
    if (!durableMatchesFlow(current, flow)) {
      throw new Error("记录合并流程已在其他标签页取消或改变，请重新发起。")
    }
  })
}

async function clearCurrentMergeArtifacts(
  flow: PendingAccountFlow,
  preserveMarker: boolean,
) {
  await withAccountMergeStorageLock(() => {
    const durableRaw = localStorage.getItem(
      ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY,
    )
    if (storedDurableMatchesFlow(durableRaw, flow)) {
      saveDurableMergeFlow(null)
    }
    if (preserveMarker) return
    const markerRaw = localStorage.getItem(ACCOUNT_MERGE_HANDOFF_MARKER_KEY)
    if (storedMarkerMatchesFlow(markerRaw, flow)) {
      saveMergeHandoffMarker(null)
    }
  })
}

async function clearDurableCapabilityForFlow(flow: PendingAccountFlow) {
  await clearCurrentMergeArtifacts(flow, true)
}

async function clearAllMergeArtifactsForFlow(flow: PendingAccountFlow) {
  await clearCurrentMergeArtifacts(flow, false)
}

async function clearMarkerIfUnchanged(expectedRaw: string | null) {
  if (!expectedRaw) return
  await withAccountMergeStorageLock(() => {
    if (
      localStorage.getItem(ACCOUNT_MERGE_HANDOFF_MARKER_KEY) === expectedRaw
    ) {
      saveMergeHandoffMarker(null)
    }
  })
}

function LoadingAccount() {
  return (
    <div
      className="flex min-h-[440px] items-center justify-center"
      role="status"
    >
      <LoaderCircle className="size-6 animate-spin text-indigo-600" />
      <span className="sr-only">正在读取账号状态</span>
    </div>
  )
}

function FlowRail({ permanent }: { permanent: boolean }) {
  const items = [
    {
      title: permanent ? "记录已可同步" : "当前记录不变",
      description: permanent
        ? "任务、学习时段和复盘与邮箱账号绑定。"
        : "绑定新邮箱时保留原 user_id，不复制、不丢失。",
      icon: Database,
    },
    {
      title: "只验证邮箱所有权",
      description: "六位验证码 10 分钟有效，不设置密码。",
      icon: KeyRound,
    },
    {
      title: "跨设备恢复",
      description: "之后在新设备用同一邮箱验证，即可继续已有记录。",
      icon: Cloud,
    },
  ]

  return (
    <ol className="space-y-6" aria-label="账号同步说明">
      {items.map(({ title, description, icon: Icon }, index) => (
        <li key={title} className="flex gap-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-indigo-100 text-indigo-700">
            {permanent && index === 0 ? (
              <Check className="size-5" />
            ) : (
              <Icon className="size-5" />
            )}
          </span>
          <div>
            <p className="font-medium text-white">{title}</p>
            <p className="mt-1 max-w-md text-sm leading-6 text-indigo-200">
              {description}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

function TransferSummary({ summary }: { summary: AccountTransferSummary }) {
  return (
    <div className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-950">
      <p className="font-medium">当前浏览器中将保存</p>
      <p className="mt-1 leading-6 text-indigo-800">
        {summary.tasks} 个任务 · {summary.sessions} 次学习时段 ·{" "}
        {summary.reviews} 次复盘
      </p>
    </div>
  )
}

function MergeResultNotice({ result }: { result: AccountMergeResult }) {
  return (
    <Alert className="border-emerald-200 bg-emerald-50 text-emerald-950">
      <Check />
      <AlertTitle>原匿名记录已合并</AlertTitle>
      <AlertDescription>
        已带入 {result.tasks} 个任务、{result.sessions} 次学习时段和{" "}
        {result.reviews} 次复盘。
      </AlertDescription>
    </Alert>
  )
}

export function AuthScreen() {
  const router = useRouter()
  const recoveryStarted = useRef(false)
  const operationInFlight = useRef(false)
  const operationPanelRef = useRef<HTMLElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const otpInputRef = useRef<HTMLInputElement>(null)
  const previousOperationStep = useRef<string | null>(null)
  const [loading, setLoading] = useState(supabaseConfigured)
  const [busy, setBusy] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [summary, setSummary] = useState<AccountTransferSummary | null>(null)
  const [pending, setPending] = useState<PendingAccountFlow | null>(null)
  const [email, setEmail] = useState("")
  const [otp, setOtp] = useState("")
  const [error, setError] = useState<string | null>(
    supabaseConfigured ? null : missingSupabaseMessage,
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [mergeResult, setMergeResult] = useState<AccountMergeResult | null>(
    null,
  )
  const [captchaToken, setCaptchaToken] = useState<string | undefined>()
  const [captchaVersion, setCaptchaVersion] = useState(0)
  const [showResendChallenge, setShowResendChallenge] = useState(false)
  const [showDeleteChallenge, setShowDeleteChallenge] = useState(false)
  const [now, setNow] = useState(0)

  const resetCaptcha = useCallback(() => {
    setCaptchaToken(undefined)
    setCaptchaVersion((value) => value + 1)
  }, [])

  const refreshSummary = useCallback(async (nextUser: User | null) => {
    if (!nextUser) {
      setSummary(null)
      return
    }
    const nextSummary = await getAccountTransferSummary()
    setSummary(nextSummary)
  }, [])

  const requireTargetReverification = useCallback(
    async (flow: PendingAccountFlow) => {
      const reverifyFlow: PendingAccountFlow = {
        kind: "sign_in",
        email: flow.email,
        sentAt: 0,
        preparedAt: Date.now(),
      }
      setPending(reverifyFlow)
      setOtp("")
      savePendingFlow(reverifyFlow)
      saveMergeRecovery(null)
      await clearDurableCapabilityForFlow(flow)
      setNotice("请重新发送验证码，验证目标邮箱并核对合并记录。")
    },
    [],
  )

  useEffect(() => {
    if (!supabaseConfigured) return

    let active = true
    const supabase = getSupabase()
    // An intermediate development build used a different durable key.
    // Remove it proactively. The current durable capability is strictly
    // limited to the server's original ten-minute prepared window and never
    // contains a Supabase access or refresh token.
    localStorage.removeItem(legacyDurableMergeFlowKey)
    const sessionStoredValue = sessionStorage.getItem(ACCOUNT_FLOW_STORAGE_KEY)
    const storedFlow = parsePendingAccountFlow(sessionStoredValue)
    const hadStoredValue = Boolean(sessionStoredValue)
    const storedRecovery = parseAnonymousMergeRecovery(
      sessionStorage.getItem(ACCOUNT_MERGE_RECOVERY_STORAGE_KEY),
    )
    const durableStoredValue = localStorage.getItem(
      ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY,
    )
    const durableMergeFlow = parseAccountMergeDurableFlow(durableStoredValue)
    const handoffStoredValue = localStorage.getItem(
      ACCOUNT_MERGE_HANDOFF_MARKER_KEY,
    )
    const handoffMarker = parseAccountMergeHandoffMarker(handoffStoredValue)
    if (
      (durableStoredValue && !durableMergeFlow) ||
      (handoffStoredValue && !handoffMarker)
    ) {
      void withAccountMergeStorageLock(() => {
        if (
          durableStoredValue &&
          !durableMergeFlow &&
          localStorage.getItem(ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY) ===
            durableStoredValue
        ) {
          saveDurableMergeFlow(null)
        }
        if (
          handoffStoredValue &&
          !handoffMarker &&
          localStorage.getItem(ACCOUNT_MERGE_HANDOFF_MARKER_KEY) ===
            handoffStoredValue
        ) {
          saveMergeHandoffMarker(null)
        }
      })
    }
    void supabase.auth.getSession().then(async ({ data, error: authError }) => {
      if (!active) return
      let activeStoredFlow =
        storedFlow ??
        (durableMergeFlow
          ? pendingMergeFromDurableFlow(durableMergeFlow)
          : null)
      let activeStoredRecovery = storedRecovery
      if (hadStoredValue && !storedFlow && !durableMergeFlow) {
        setNotice("上次验证已过期，请重新发起。")
        saveMergeRecovery(null)
        savePendingFlow(null)
      }
      if (activeStoredFlow) {
        setPending(activeStoredFlow)
        setEmail(activeStoredFlow.email)
        if (!storedFlow) savePendingFlow(activeStoredFlow)
      } else {
        savePendingFlow(null)
        saveMergeRecovery(null)
      }
      if (
        activeStoredFlow?.kind === "merge" &&
        activeStoredFlow.mergeRecoveryRequired &&
        (!activeStoredRecovery ||
          activeStoredRecovery.sourceUserId !== activeStoredFlow.sourceUserId ||
          activeStoredRecovery.email !== activeStoredFlow.email)
      ) {
        activeStoredRecovery = null
        saveMergeRecovery(null)
      }
      if (authError) {
        if (!isDefinitivelyMissingAuthUser(authError)) {
          setError(friendlyAccountError(authError))
          setLoading(false)
          return
        }
        try {
          const outcome = await clearDefinitivelyStaleAuthSession(
            handoffMarker?.sourceUserId ?? null,
          )
          if (outcome !== "cleared") {
            throw new Error("当前账号已在其他标签页改变，请刷新后继续恢复。")
          }
          if (activeStoredFlow?.kind === "merge") {
            await clearDurableCapabilityForFlow(activeStoredFlow)
          }
          setUser(null)
          setPending(null)
          savePendingFlow(null)
          saveMergeRecovery(null)
          if (handoffMarker) setEmail(handoffMarker.email)
          setNotice(
            handoffMarker
              ? "上次匿名身份已失效。请用刚验证的邮箱重新登录并核对合并记录。"
              : "临时身份已失效，请重新开始体验。",
          )
        } catch (staleError) {
          setError(friendlyAccountError(staleError))
        } finally {
          setLoading(false)
        }
        return
      }

      const currentUser = data.session?.user ?? null
      setUser(currentUser)
      try {
        if (
          activeStoredFlow?.kind === "merge" &&
          !activeStoredRecovery &&
          handoffMarker &&
          handoffMarker.sourceUserId === activeStoredFlow.sourceUserId &&
          handoffMarker.email === activeStoredFlow.email &&
          currentUser &&
          !currentUser.is_anonymous &&
          currentUser.id === handoffMarker.targetUserId &&
          currentUser.email &&
          normalizeEmail(currentUser.email) === handoffMarker.email &&
          data.session?.access_token &&
          data.session.refresh_token
        ) {
          // Handles the crash window after the target session was committed
          // but before local recovery state was cleared. The current exact
          // session still has to read the server-side receipt below.
          activeStoredRecovery = {
            sourceUserId: handoffMarker.sourceUserId,
            targetUserId: handoffMarker.targetUserId,
            email: handoffMarker.email,
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            capturedAt: Date.now(),
          }
          saveMergeRecovery(activeStoredRecovery)
          activeStoredFlow = {
            ...activeStoredFlow,
            mergeTargetUserId: handoffMarker.targetUserId,
            mergeRecoveryRequired: true,
          }
          setPending(activeStoredFlow)
          savePendingFlow(activeStoredFlow)
        }

        if (
          activeStoredFlow?.kind === "merge" &&
          activeStoredFlow.mergeRecoveryRequired &&
          activeStoredRecovery &&
          !recoveryStarted.current
        ) {
          recoveryStarted.current = true
          const recovered = await resumePendingAccountFlow(
            activeStoredFlow,
            currentUser,
            activeStoredRecovery,
            saveMergeRecovery,
          )
          if (recovered) {
            setUser(recovered.user)
            setMergeResult(recovered.merge)
            if (recovered.recoveredWithoutReceipt) {
              setNotice(
                "匿名身份已由服务器确认移除，邮箱账号已恢复；旧回执不可用，请核对任务记录。",
              )
            } else {
              setNotice("邮箱账号已恢复，记录同步完成。")
            }
            setPending(null)
            savePendingFlow(null)
            saveMergeRecovery(null)
            await clearAllMergeArtifactsForFlow(activeStoredFlow)
            try {
              await touchMyActivity()
              await refreshSummary(recovered.user)
            } catch (summaryError) {
              setError(
                `账号已恢复，但同步摘要刷新失败：${friendlyAccountError(summaryError)}`,
              )
            }
          }
          return
        }

        if (
          currentUser?.is_anonymous &&
          !(
            activeStoredFlow?.kind === "merge" &&
            activeStoredFlow.mergeRecoveryRequired &&
            activeStoredRecovery
          )
        ) {
          const { data: verified, error: verificationError } =
            await supabase.auth.getUser()
          if (verificationError) {
            if (!isDefinitivelyMissingAuthUser(verificationError)) {
              throw verificationError
            }
            const recoveryEmail =
              activeStoredFlow?.email ?? handoffMarker?.email
            const staleOutcome = await clearDefinitivelyStaleAuthSession(
              currentUser.id,
            )
            if (staleOutcome !== "cleared") {
              throw new Error("当前账号已在其他标签页改变，请刷新后继续恢复。")
            }
            if (activeStoredFlow?.kind === "merge") {
              await clearDurableCapabilityForFlow(activeStoredFlow)
            }
            activeStoredFlow = null
            activeStoredRecovery = null
            setUser(null)
            setPending(null)
            savePendingFlow(null)
            saveMergeRecovery(null)
            if (recoveryEmail) setEmail(recoveryEmail)
            setNotice(
              recoveryEmail
                ? "上次匿名身份已失效。请用刚验证的邮箱重新登录并核对合并记录。"
                : "临时身份已失效，请重新开始体验。",
            )
            return
          }
          if (
            !verified.user?.is_anonymous ||
            verified.user.id !== currentUser.id
          ) {
            throw new Error("当前匿名身份验证结果不一致，请刷新后重试")
          }
        }

        if (!activeStoredFlow && handoffMarker) {
          setEmail(handoffMarker.email)
          setNotice(
            currentUser?.is_anonymous
              ? "上次合并页面已关闭，请重新发起邮箱验证；若服务器仍在处理，请稍后重试。"
              : "请用刚验证的邮箱登录，并核对上次合并的记录。",
          )
        }

        if (
          activeStoredFlow?.kind === "merge" &&
          activeStoredFlow.mergeRecoveryRequired &&
          !activeStoredRecovery &&
          (!currentUser ||
            (currentUser.is_anonymous &&
              currentUser.id === activeStoredFlow.sourceUserId))
        ) {
          activeStoredFlow = {
            ...activeStoredFlow,
            mergeRecoveryRequired: false,
          }
          activeStoredRecovery = null
          setPending(activeStoredFlow)
          savePendingFlow(activeStoredFlow)
          saveMergeRecovery(null)
          setNotice("目标会话未保留，请重新输入邮箱验证码继续确认。")
        } else if (
          activeStoredFlow?.kind === "merge" &&
          activeStoredFlow.mergeRecoveryRequired &&
          !activeStoredRecovery
        ) {
          setError(
            "短时目标会话已丢失，无法判断合并结果。合并凭证仍保留，请勿取消；请重新打开原匿名会话或联系项目管理员核对记录。",
          )
        }

        if (currentUser) {
          await touchMyActivity()
          await refreshSummary(currentUser)
        }

        if (
          activeStoredFlow &&
          currentUser &&
          activeStoredFlow.kind !== "merge" &&
          activeStoredFlow.kind !== "confirm_merge" &&
          activeStoredFlow.kind !== "delete" &&
          !recoveryStarted.current
        ) {
          recoveryStarted.current = true
          const recovered = await resumePendingAccountFlow(
            activeStoredFlow,
            currentUser,
            activeStoredRecovery,
          )
          if (recovered) {
            setUser(recovered.user)
            setMergeResult(recovered.merge)
            setNotice("邮箱账号已恢复，记录同步完成。")
            setPending(null)
            savePendingFlow(null)
            saveMergeRecovery(null)
            await refreshSummary(recovered.user)
          }
        }
      } catch (loadError) {
        if (activeStoredFlow?.kind === "merge") {
          if (isMergeSourceRestored(loadError)) {
            const retryableFlow = {
              ...activeStoredFlow,
              mergeRecoveryRequired: false,
            }
            setPending(retryableFlow)
            savePendingFlow(retryableFlow)
            saveMergeRecovery(null)
          } else if (isMergeTargetReverificationRequired(loadError)) {
            await requireTargetReverification(activeStoredFlow)
          } else if (isMergeResultUncertain(loadError)) {
            const recoveryFlow = {
              ...activeStoredFlow,
              mergeRecoveryRequired: true,
            }
            setPending(recoveryFlow)
            savePendingFlow(recoveryFlow)
          }
        }
        setError(friendlyAccountError(loadError))
      } finally {
        if (active) setLoading(false)
      }
    })

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (active) setUser(session?.user ?? null)
      },
    )
    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [refreshSummary, requireTargetReverification])

  useEffect(() => {
    if (!pending) return
    const frame = window.requestAnimationFrame(() => setNow(Date.now()))
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [pending])

  const resendRemaining = useMemo(() => {
    if (!pending) return 0
    if (now === 0) return OTP_RESEND_SECONDS
    return Math.max(
      0,
      OTP_RESEND_SECONDS - Math.floor((now - pending.sentAt) / 1_000),
    )
  }, [now, pending])

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const flow = await beginEmailAccountFlow(email, captchaToken)
      setPending(flow)
      savePendingFlow(flow)
      setEmail(flow.email)
      setOtp("")
      setNow(Date.now())
    } catch (submitError) {
      setError(friendlyAccountError(submitError))
    } finally {
      setBusy(false)
      resetCaptcha()
    }
  }

  const submitOtp = async (event: FormEvent) => {
    event.preventDefault()
    if (!pending || otp.length !== 6 || operationInFlight.current) return
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    const expectedMarkerRaw = localStorage.getItem(
      ACCOUNT_MERGE_HANDOFF_MARKER_KEY,
    )
    try {
      if (pending.kind === "delete") {
        await verifyAndDeleteAccount(pending, otp)
        setPending(null)
        savePendingFlow(null)
        router.replace("/app")
        return
      }

      const result = await verifyAccountOtp(
        pending,
        otp,
        async (mergeRecovery) => {
          const attemptFlow = {
            ...pending,
            sentAt: Date.now(),
            mergeTargetUserId: mergeRecovery.targetUserId,
            mergeRecoveryRequired: true,
          }
          if (
            !pending.sourceUserId ||
            !pending.mergeSecret ||
            !pending.preparedAt
          ) {
            throw new Error("记录合并准备状态不完整")
          }
          saveMergeRecovery(mergeRecovery)
          await attachTargetToDurableMerge(pending, mergeRecovery)
          setPending(attemptFlow)
          savePendingFlow(attemptFlow)
        },
      )
      const currentHandoff = parseAccountMergeHandoffMarker(
        localStorage.getItem(ACCOUNT_MERGE_HANDOFF_MARKER_KEY),
      )
      if (pending.kind === "sign_in" && currentHandoff) {
        await withSupabaseAuthMutationLock(async () => {
          const supabase = getSupabase()
          const { data: live, error: liveError } =
            await supabase.auth.getSession()
          if (liveError) throw liveError
          if (live.session?.user.id !== result.user.id) {
            throw new Error("当前账号已在其他标签页改变，请重新验证目标邮箱。")
          }
          if (
            (currentHandoff.targetUserId !== undefined &&
              result.user.id !== currentHandoff.targetUserId) ||
            !result.user.email ||
            normalizeEmail(result.user.email) !== currentHandoff.email
          ) {
            const { error: signOutError } = await supabase.auth.signOut({
              scope: "local",
            })
            if (signOutError) throw signOutError
            throw new Error(
              "验证的邮箱账号与上次合并目标不一致，已停止恢复并保留核对信息。",
            )
          }
          const { data: verified, error: verificationError } =
            await supabase.auth.getUser()
          if (verificationError) throw verificationError
          if (
            currentHandoff.targetUserId !== undefined &&
            verified.user?.id !== currentHandoff.targetUserId
          ) {
            throw new Error("目标邮箱账号的服务器验证结果不一致。")
          }
        })
      }
      setUser(result.user)
      setMergeResult(result.merge)
      setPending(null)
      savePendingFlow(null)
      saveMergeRecovery(null)
      if (pending.kind === "merge") {
        await clearAllMergeArtifactsForFlow(pending)
      } else {
        await clearMarkerIfUnchanged(expectedMarkerRaw)
      }
      setNotice(
        result.recoveredWithoutReceipt
          ? "匿名身份已由服务器确认移除；旧回执不可用，请核对任务记录。"
          : result.merge
            ? "已登录并合并当前浏览器的记录。"
            : "邮箱验证完成，记录已可跨设备恢复。",
      )
      try {
        await refreshSummary(result.user)
      } catch (summaryError) {
        setError(
          `邮箱验证已经完成，但同步摘要刷新失败：${friendlyAccountError(summaryError)}`,
        )
      }
    } catch (verifyError) {
      if (pending.kind === "merge") {
        if (isMergeSourceRestored(verifyError)) {
          const retryableFlow = {
            ...pending,
            mergeRecoveryRequired: false,
          }
          setPending(retryableFlow)
          savePendingFlow(retryableFlow)
          saveMergeRecovery(null)
        } else if (isMergeTargetReverificationRequired(verifyError)) {
          await requireTargetReverification(pending)
        } else if (isMergeResultUncertain(verifyError)) {
          const recoveryFlow = {
            ...pending,
            mergeRecoveryRequired: true,
          }
          setPending(recoveryFlow)
          savePendingFlow(recoveryFlow)
        } else {
          const otpFlow = { ...pending, mergeRecoveryRequired: false }
          setPending(otpFlow)
          savePendingFlow(otpFlow)
          saveMergeRecovery(null)
        }
      }
      setError(friendlyAccountError(verifyError))
    } finally {
      operationInFlight.current = false
      setBusy(false)
    }
  }

  const confirmMerge = async (token?: string) => {
    if (!pending || pending.kind !== "confirm_merge") return
    if (operationInFlight.current) return
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const flow = await withSupabaseAuthMutationLock(async () => {
        const candidate = createPreparedAccountMergeFlow(pending)
        const preparedFlow = await claimDurableMergeFlow(candidate)
        setPending(preparedFlow)
        savePendingFlow(preparedFlow)
        // Persist the random capability before the prepare request. If the
        // database commits but the HTTP response is lost, closing this tab
        // must not strand records behind an unknown prepared token. The Web
        // Lock plus compare-and-set prevents a second tab replacing it.
        try {
          return await confirmAccountMerge(preparedFlow, token)
        } catch (confirmationError) {
          if (isDefinitiveAccountRpcRollback(confirmationError)) {
            let revoked = false
            try {
              revoked = await cancelPendingAccountFlow(preparedFlow)
            } catch {
              // The prepare result is known, but a concurrent tab may already
              // have consumed this shared capability. Only the server's
              // affirmative cancellation permits local compare-and-remove.
            }
            if (revoked) {
              await clearAllMergeArtifactsForFlow(preparedFlow)
              setPending(pending)
              savePendingFlow(pending)
              saveMergeRecovery(null)
            }
          }
          throw confirmationError
        }
      })
      setPending(flow)
      savePendingFlow(flow)
      setOtp("")
      setNow(Date.now())
      setNotice("验证码已发送，验证后才会开始合并。")
    } catch (confirmationError) {
      setError(friendlyAccountError(confirmationError))
    } finally {
      operationInFlight.current = false
      setBusy(false)
      resetCaptcha()
    }
  }

  const resend = async (token?: string) => {
    if (!pending) return
    if (operationInFlight.current) return
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const nextFlow = await withSupabaseAuthMutationLock(async () => {
        if (pending.kind === "merge") {
          await assertDurableMergeFlowCurrent(pending)
        }
        return resendAccountOtp(pending, token)
      })
      setPending(nextFlow)
      savePendingFlow(nextFlow)
      setNow(Date.now())
      setNotice("新的验证码已发送。")
      setShowResendChallenge(false)
    } catch (resendError) {
      setError(friendlyAccountError(resendError))
    } finally {
      operationInFlight.current = false
      setBusy(false)
      resetCaptcha()
    }
  }

  const requestDeletion = async (token?: string) => {
    if (!user) return
    if (operationInFlight.current) return
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const preparedFlow = createPreparedAccountDeletionFlow(user)
      setPending(preparedFlow)
      savePendingFlow(preparedFlow)
      const flow = await requestAccountDeletionOtp(user, preparedFlow, token)
      setPending(flow)
      savePendingFlow(flow)
      setOtp("")
      setNow(Date.now())
      setShowDeleteChallenge(false)
      setNotice(null)
    } catch (deletionError) {
      setError(friendlyAccountError(deletionError))
    } finally {
      operationInFlight.current = false
      setBusy(false)
      resetCaptcha()
    }
  }

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      await signOutSafely()
      router.replace("/app")
    } catch (signOutError) {
      setError(friendlyAccountError(signOutError))
    } finally {
      setBusy(false)
    }
  }

  const cancelPending = async () => {
    if (!pending || operationInFlight.current) return
    if (
      pending.kind === "merge" &&
      (pending.mergeRecoveryRequired ||
        Boolean(user && !user.is_anonymous && user.id !== pending.sourceUserId))
    ) {
      setError(
        "合并结果仍在确认中，请先重试确认；为避免记录失联，当前不能取消。",
      )
      return
    }
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const revoked = await withSupabaseAuthMutationLock(async () => {
        const cancelled = await cancelPendingAccountFlow(pending)
        if (cancelled && pending.kind === "merge") {
          // Keep the database cancellation and the capability CAS under the
          // same cross-tab auth lock. A waiting confirm/resend cannot revive
          // the same capability between those two operations.
          await clearAllMergeArtifactsForFlow(pending)
        }
        return cancelled
      })
      if (!revoked) {
        setError(
          "服务器中的验证状态已变化。请保留当前页面并刷新，以恢复已完成的合并或重试。",
        )
        return
      }
      setPending(null)
      setOtp("")
      savePendingFlow(null)
      saveMergeRecovery(null)
      setNotice("已取消本次验证，可以立即重新发起。")
    } catch (cancelError) {
      setError(friendlyAccountError(cancelError))
    } finally {
      operationInFlight.current = false
      setBusy(false)
    }
  }

  const retryMergeRecovery = async () => {
    if (
      !pending ||
      pending.kind !== "merge" ||
      !pending.mergeRecoveryRequired ||
      operationInFlight.current
    ) {
      return
    }
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const recovery = parseAnonymousMergeRecovery(
        sessionStorage.getItem(ACCOUNT_MERGE_RECOVERY_STORAGE_KEY),
      )
      const recovered = await resumePendingAccountFlow(
        pending,
        user,
        recovery,
        saveMergeRecovery,
      )
      if (!recovered) throw new Error("暂时无法确认记录合并结果")
      setUser(recovered.user)
      setMergeResult(recovered.merge)
      if (recovered.recoveredWithoutReceipt) {
        setNotice(
          "匿名身份已由服务器确认移除，邮箱账号已恢复；旧回执不可用，请核对任务记录。",
        )
      } else {
        setNotice("邮箱账号已恢复，记录同步完成。")
      }
      setPending(null)
      savePendingFlow(null)
      saveMergeRecovery(null)
      await clearAllMergeArtifactsForFlow(pending)
      try {
        await touchMyActivity()
        await refreshSummary(recovered.user)
      } catch (summaryError) {
        setError(
          `账号已恢复，但同步摘要刷新失败：${friendlyAccountError(summaryError)}`,
        )
      }
    } catch (retryError) {
      if (isMergeSourceRestored(retryError)) {
        const retryableFlow = {
          ...pending,
          mergeRecoveryRequired: false,
        }
        setPending(retryableFlow)
        savePendingFlow(retryableFlow)
        saveMergeRecovery(null)
      } else if (isMergeTargetReverificationRequired(retryError)) {
        await requireTargetReverification(pending)
      }
      setError(friendlyAccountError(retryError))
    } finally {
      operationInFlight.current = false
      setBusy(false)
    }
  }

  const permanent = Boolean(user && !user.is_anonymous && user.email)
  const operationStep = loading
    ? "loading"
    : pending?.kind === "confirm_merge"
      ? "confirm-merge"
      : pending?.kind === "merge" && pending.mergeRecoveryRequired
        ? "merge-recovery"
        : pending
          ? `otp-${pending.kind}`
          : permanent
            ? "account"
            : "email"

  useEffect(() => {
    if (previousOperationStep.current === null) {
      previousOperationStep.current = operationStep
      return
    }
    if (previousOperationStep.current === operationStep) return
    previousOperationStep.current = operationStep

    const frame = window.requestAnimationFrame(() => {
      if (operationStep.startsWith("otp-")) otpInputRef.current?.focus()
      else if (operationStep === "email") emailInputRef.current?.focus()
      else operationPanelRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [operationStep])

  return (
    <main className="min-h-screen bg-[var(--app-canvas)] px-4 py-5 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex items-center justify-between">
          <Link
            href="/app"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-medium text-slate-600 outline-none hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <ArrowLeft className="size-4" /> 返回任务
          </Link>
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-950">
            <span className="grid size-8 place-items-center rounded-lg bg-indigo-700 text-white">
              <BookOpenCheck className="size-4" />
            </span>
            学迹 StudyTrace
          </span>
        </header>

        <div className="mt-5 grid overflow-hidden rounded-2xl bg-white shadow-lg shadow-indigo-950/8 sm:mt-8 lg:min-h-[620px] lg:grid-cols-[0.9fr_1.1fr]">
          <section className="order-2 bg-indigo-950 px-6 py-6 text-white sm:px-10 sm:py-8 lg:order-1 lg:px-12 lg:py-12">
            <Badge className="border-indigo-500/50 bg-indigo-900 text-indigo-100 hover:bg-indigo-900">
              {permanent ? "已安全同步" : "可选的长期保存"}
            </Badge>
            <h1 className="mt-5 max-w-lg text-2xl font-semibold tracking-[-0.03em] text-balance sm:text-3xl lg:mt-6 lg:text-4xl">
              {permanent
                ? "你的记录可以跨设备继续。"
                : "先体验，需要时再保存。"}
            </h1>
            <p className="mt-4 max-w-lg text-sm leading-7 text-indigo-200 sm:text-base">
              {permanent
                ? "邮箱只用于验证身份和恢复记录。摄像头画面、人脸关键点和音频仍然不会上传。"
                : "匿名体验仍然是完整产品。绑定邮箱只是让你能在清除浏览器数据或更换设备后找回历史。"}
            </p>
            <div className="mt-10 hidden border-t border-indigo-800 pt-8 lg:block">
              <FlowRail permanent={permanent} />
            </div>
          </section>

          <section
            ref={operationPanelRef}
            tabIndex={-1}
            aria-label="账号操作"
            className="order-1 px-6 py-8 outline-none sm:px-10 sm:py-12 lg:order-2 lg:px-14"
          >
            {loading ? (
              <LoadingAccount />
            ) : pending?.kind === "confirm_merge" ? (
              <div className="mx-auto max-w-md">
                <div className="grid size-11 place-items-center rounded-xl bg-amber-100 text-amber-800">
                  <Database className="size-5" />
                </div>
                <h2 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">
                  确认合并当前记录
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  <span className="font-medium text-slate-900">
                    {maskEmail(pending.email)}
                  </span>{" "}
                  已经有一个学迹账号。只有在你确认并通过邮箱验证后，当前匿名记录才会合并进去。
                </p>

                {summary ? (
                  <div className="mt-6">
                    <TransferSummary summary={summary} />
                  </div>
                ) : null}
                <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-950">
                  <ShieldCheck />
                  <AlertTitle>合并保留原账号设置</AlertTitle>
                  <AlertDescription>
                    任务、学习时段、事件和复盘会导入；已有账号的设置不会被覆盖。合并凭证只能使用一次，10
                    分钟后过期。
                  </AlertDescription>
                </Alert>

                {summary?.hasActiveSession ? (
                  <p
                    className="mt-4 text-sm leading-6 text-amber-800"
                    role="alert"
                  >
                    当前还有未结束的学习时段，请先返回任务处理后再合并。
                  </p>
                ) : null}
                {error ? (
                  <p className="text-destructive mt-4 text-sm" role="alert">
                    {error}
                  </p>
                ) : null}

                {turnstileSiteKey ? (
                  <div className="mt-5 rounded-xl border border-slate-200 p-3">
                    <p className="mb-3 text-sm text-slate-600">
                      合并前再做一次安全校验，防止验证邮件被滥用。
                    </p>
                    <TurnstileChallenge
                      key={`merge-${captchaVersion}`}
                      siteKey={turnstileSiteKey}
                      onSuccess={setCaptchaToken}
                      onInvalidate={() => setCaptchaToken(undefined)}
                    />
                  </div>
                ) : null}

                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
                  <Button
                    variant="outline"
                    className="min-h-11 flex-1"
                    onClick={() => void cancelPending()}
                    disabled={busy}
                  >
                    暂不合并
                  </Button>
                  <Button
                    className="min-h-11 flex-1"
                    onClick={() => void confirmMerge(captchaToken)}
                    disabled={
                      busy ||
                      summary?.hasActiveSession ||
                      Boolean(turnstileSiteKey && !captchaToken)
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Mail />
                    )}
                    确认并发送验证码
                  </Button>
                </div>
              </div>
            ) : pending?.kind === "merge" && pending.mergeRecoveryRequired ? (
              <div className="mx-auto max-w-md">
                <div className="grid size-11 place-items-center rounded-xl bg-indigo-100 text-indigo-700">
                  <Cloud className="size-5" />
                </div>
                <h2 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">
                  正在确认合并结果
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  验证已切换到
                  <span className="mx-1 font-medium text-slate-900">
                    {maskEmail(pending.email)}
                  </span>
                  。当前浏览器仍保留匿名会话；系统会用隔离的目标会话查询短时回执，不会重复导入记录。
                </p>
                <Alert className="mt-5 border-amber-200 bg-amber-50 text-amber-950">
                  <ShieldCheck />
                  <AlertTitle>此时不能取消或更换邮箱</AlertTitle>
                  <AlertDescription>
                    网络中断时无法立即判断事务是否已提交。先重试确认；若合并未提交，原匿名记录仍由当前浏览器持有。
                  </AlertDescription>
                </Alert>
                {error ? (
                  <p className="text-destructive mt-4 text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
                <Button
                  className="mt-6 h-11 w-full"
                  onClick={() => void retryMergeRecovery()}
                  disabled={busy}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <Cloud />}
                  重试确认合并
                </Button>
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  若数据库明确返回未提交，系统会回到普通验证态，再允许取消或重新发起。
                </p>
              </div>
            ) : pending ? (
              <div className="mx-auto max-w-md">
                <div className="grid size-11 place-items-center rounded-xl bg-indigo-100 text-indigo-700">
                  {pending.kind === "delete" ? (
                    <Trash2 className="size-5" />
                  ) : (
                    <Mail className="size-5" />
                  )}
                </div>
                <h2 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">
                  {pending.kind === "delete"
                    ? "验证后永久删除"
                    : "输入邮件中的六位数字"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {pending.sentAt > 0
                    ? "验证码已发送至 "
                    : "请重新发送验证码至 "}
                  <span className="font-medium text-slate-900">
                    {maskEmail(pending.email)}
                  </span>
                  ，10 分钟内有效。
                </p>

                {pending.kind === "merge" ? (
                  <Alert className="mt-5 border-amber-200 bg-amber-50 text-amber-950">
                    <ShieldCheck />
                    <AlertTitle>这个邮箱已有记录</AlertTitle>
                    <AlertDescription>
                      验证后会将当前匿名记录原子合并到该账号，原账号设置保持不变。
                    </AlertDescription>
                  </Alert>
                ) : null}

                <form className="mt-7 space-y-5" onSubmit={submitOtp}>
                  <div className="space-y-2">
                    <Label htmlFor="account-otp">验证码</Label>
                    <Input
                      ref={otpInputRef}
                      id="account-otp"
                      name="otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      className="h-12 text-center text-xl tracking-[0.3em] tabular-nums"
                      value={otp}
                      onChange={(event) =>
                        setOtp(normalizeOtp(event.target.value))
                      }
                      aria-invalid={Boolean(error)}
                    />
                  </div>
                  {error ? (
                    <p className="text-destructive text-sm" role="alert">
                      {error}
                    </p>
                  ) : null}
                  {notice ? (
                    <p className="text-sm text-emerald-700" role="status">
                      {notice}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    size="lg"
                    className={
                      pending.kind === "delete"
                        ? "h-11 w-full bg-red-700 hover:bg-red-800"
                        : "h-11 w-full"
                    }
                    disabled={busy || otp.length !== 6}
                  >
                    {busy ? <LoaderCircle className="animate-spin" /> : null}
                    {pending.kind === "delete"
                      ? "永久删除账号与全部记录"
                      : "完成验证"}
                  </Button>
                </form>

                <div className="mt-5 flex min-h-11 items-center justify-between gap-3 text-sm">
                  <Button
                    variant="ghost"
                    className="min-h-11 px-2 text-slate-600"
                    onClick={() => void cancelPending()}
                    disabled={busy}
                  >
                    {pending.kind === "delete" ? "取消删除" : "更换邮箱"}
                  </Button>
                  {resendRemaining > 0 ? (
                    <span className="text-slate-500 tabular-nums">
                      {resendRemaining} 秒后可重发
                    </span>
                  ) : turnstileSiteKey ? (
                    <Button
                      variant="ghost"
                      className="min-h-11 px-2 text-indigo-700"
                      onClick={() => setShowResendChallenge(true)}
                      disabled={busy}
                    >
                      重新获取
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      className="min-h-11 px-2 text-indigo-700"
                      onClick={() => void resend()}
                      disabled={busy}
                    >
                      重新获取
                    </Button>
                  )}
                </div>

                {showResendChallenge && turnstileSiteKey ? (
                  <div className="mt-4 rounded-xl border border-slate-200 p-3">
                    <p className="mb-3 text-sm text-slate-600">
                      完成安全校验后会立即重发。
                    </p>
                    <TurnstileChallenge
                      key={`resend-${captchaVersion}`}
                      siteKey={turnstileSiteKey}
                      onSuccess={(token) => void resend(token)}
                    />
                  </div>
                ) : null}
              </div>
            ) : permanent && user ? (
              <div className="mx-auto max-w-lg">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                      账号与同步
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      已通过邮箱保护当前记录。
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-emerald-800">
                    <Cloud className="size-3.5" /> 可同步
                  </Badge>
                </div>

                {notice ? (
                  <Alert className="mt-6 border-emerald-200 bg-emerald-50 text-emerald-950">
                    <Check />
                    <AlertTitle>同步状态已更新</AlertTitle>
                    <AlertDescription>{notice}</AlertDescription>
                  </Alert>
                ) : null}
                {mergeResult ? (
                  <div className="mt-4">
                    <MergeResultNotice result={mergeResult} />
                  </div>
                ) : null}
                {error ? (
                  <p className="text-destructive mt-5 text-sm" role="alert">
                    {error}
                  </p>
                ) : null}

                <dl className="mt-7 divide-y divide-slate-200 border-y border-slate-200">
                  <div className="flex items-center justify-between gap-4 py-5">
                    <dt className="text-sm text-slate-600">登录邮箱</dt>
                    <dd className="font-medium text-slate-950">
                      {maskEmail(user.email ?? "")}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-5">
                    <dt className="text-sm text-slate-600">已保存记录</dt>
                    <dd className="text-right text-sm font-medium text-slate-950">
                      {summary
                        ? `${summary.tasks} 个任务 · ${summary.sessions} 次学习时段`
                        : "正在统计"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-5">
                    <dt className="text-sm text-slate-600">摄像头画面</dt>
                    <dd className="text-sm font-medium text-slate-950">
                      仅本地处理，不同步
                    </dd>
                  </div>
                </dl>

                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <Button className="min-h-11 flex-1" asChild>
                    <Link href="/app">
                      继续任务 <ArrowRight />
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    className="min-h-11 flex-1"
                    disabled={busy}
                    onClick={() => void signOut()}
                  >
                    {busy ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <LogOut />
                    )}
                    退出当前设备
                  </Button>
                </div>

                <div className="mt-10 border-t border-slate-200 pt-7">
                  <h3 className="font-medium text-slate-950">永久删除</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    将删除账号、任务、学习时段、事件和复盘。需要再次验证邮箱，且无法恢复。
                  </p>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        className="mt-4 min-h-11 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                        disabled={busy}
                      >
                        <Trash2 /> 删除账号与全部记录
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>确定要永久删除吗？</AlertDialogTitle>
                        <AlertDialogDescription>
                          这会删除当前账号及全部学习记录。下一步仍需输入邮箱验证码，避免误操作。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="min-h-11">
                          保留账号
                        </AlertDialogCancel>
                        <AlertDialogAction
                          className="min-h-11 bg-red-700 hover:bg-red-800"
                          onClick={() => {
                            if (turnstileSiteKey) setShowDeleteChallenge(true)
                            else void requestDeletion()
                          }}
                        >
                          继续验证
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                  {showDeleteChallenge && turnstileSiteKey ? (
                    <div className="mt-4 rounded-xl border border-red-200 bg-red-50/60 p-3">
                      <p className="mb-3 text-sm text-red-800">
                        完成安全校验后，我们会向已绑定邮箱发送删除验证码。
                      </p>
                      <TurnstileChallenge
                        key={`delete-${captchaVersion}`}
                        siteKey={turnstileSiteKey}
                        onSuccess={(token) => void requestDeletion(token)}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-md">
                <div className="grid size-11 place-items-center rounded-xl bg-indigo-100 text-indigo-700">
                  <LockKeyhole className="size-5" />
                </div>
                <h2 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">
                  {user?.is_anonymous ? "保存并同步记录" : "恢复已有记录"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  {user?.is_anonymous
                    ? "绑定一个邮箱，不需设置密码。如果邮箱已有账号，验证后再安全合并。"
                    : "输入曾经绑定的邮箱，用六位验证码恢复。新用户请先直接开始匿名体验。"}
                </p>

                {user?.is_anonymous && summary ? (
                  <div className="mt-6">
                    <TransferSummary summary={summary} />
                  </div>
                ) : null}
                {summary?.hasActiveSession ? (
                  <Alert className="mt-4 border-amber-200 bg-amber-50 text-amber-950">
                    <ShieldCheck />
                    <AlertTitle>当前还有暂停中的学习时段</AlertTitle>
                    <AlertDescription>
                      绑定新邮箱不受影响；如需合并到已有账号，请先返回任务并结束该时段。
                    </AlertDescription>
                  </Alert>
                ) : null}

                <form className="mt-7 space-y-5" onSubmit={submitEmail}>
                  <div className="space-y-2">
                    <Label htmlFor="account-email">邮箱</Label>
                    <Input
                      ref={emailInputRef}
                      id="account-email"
                      name="email"
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      className="h-11"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      aria-invalid={Boolean(error)}
                    />
                  </div>

                  {turnstileSiteKey && !user?.is_anonymous ? (
                    <div className="rounded-xl border border-slate-200 p-3">
                      <p className="mb-3 text-sm text-slate-600">
                        完成一次安全校验，防止登录邮件被滥用。
                      </p>
                      <TurnstileChallenge
                        key={`initial-${captchaVersion}`}
                        siteKey={turnstileSiteKey}
                        onSuccess={setCaptchaToken}
                        onInvalidate={() => setCaptchaToken(undefined)}
                      />
                    </div>
                  ) : null}

                  {notice ? (
                    <p className="text-sm text-emerald-700" role="status">
                      {notice}
                    </p>
                  ) : null}
                  {error ? (
                    <p className="text-destructive text-sm" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    size="lg"
                    className="h-11 w-full"
                    disabled={
                      busy ||
                      !email.trim() ||
                      Boolean(
                        turnstileSiteKey &&
                        !user?.is_anonymous &&
                        !captchaToken,
                      )
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Mail />
                    )}
                    发送验证码
                  </Button>
                </form>

                {user?.is_anonymous ? (
                  <p className="mt-4 text-xs leading-5 text-slate-500">
                    绑定新邮箱由 Supabase
                    邮件限流保护；如果邮箱已有账号，合并前会再进行 Turnstile
                    安全校验。
                  </p>
                ) : null}

                {!user ? (
                  <div className="mt-6 border-t border-slate-200 pt-6">
                    <Button variant="ghost" className="min-h-11 w-full" asChild>
                      <Link href="/app">我要先直接体验</Link>
                    </Button>
                  </div>
                ) : null}

                <p className="mt-6 flex gap-2 text-xs leading-5 text-slate-500">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                  邮箱只用于身份验证与记录恢复。学迹不会向邮件服务发送任务内容、视觉事件或复盘。
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
