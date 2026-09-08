"use client"

import { Turnstile } from "@marsidev/react-turnstile"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ACCOUNT_FLOW_STORAGE_KEY,
  OTP_RESEND_SECONDS,
  friendlyAccountError,
  maskEmail,
  normalizeOtp,
  parsePendingAccountFlow,
  serializePendingAccountFlow,
  type AccountMergeResult,
  type AccountTransferSummary,
  type PendingAccountFlow,
} from "@/lib/auth/account"
import {
  beginEmailAccountFlow,
  confirmAccountMerge,
  createPreparedAccountDeletionFlow,
  createPreparedAccountMergeFlow,
  getAccountTransferSummary,
  requestAccountDeletionOtp,
  resendAccountOtp,
  resumePendingAccountFlow,
  signOutSafely,
  touchMyActivity,
  verifyAccountOtp,
  verifyAndDeleteAccount,
} from "@/lib/auth/account-repository"
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"

const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
const supabaseConfigured = hasSupabaseConfig()
const missingSupabaseMessage = "体验环境尚未配置 Supabase 公开变量。"

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
            <p className="font-medium text-slate-950">{title}</p>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-600">
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

  useEffect(() => {
    if (!supabaseConfigured) return

    let active = true
    const supabase = getSupabase()
    const storedValue = sessionStorage.getItem(ACCOUNT_FLOW_STORAGE_KEY)
    const storedFlow = parsePendingAccountFlow(storedValue)
    void supabase.auth.getSession().then(async ({ data, error: authError }) => {
      if (!active) return
      if (storedValue && !storedFlow) {
        setNotice("上次验证已过期，请重新发起。")
      }
      if (storedFlow) {
        setPending(storedFlow)
        setEmail(storedFlow.email)
      } else {
        savePendingFlow(null)
      }
      if (authError) {
        setError(friendlyAccountError(authError))
        setLoading(false)
        return
      }

      const currentUser = data.session?.user ?? null
      setUser(currentUser)
      try {
        if (currentUser) {
          await touchMyActivity()
          await refreshSummary(currentUser)
        }

        if (
          storedFlow &&
          currentUser &&
          !currentUser.is_anonymous &&
          storedFlow.kind !== "confirm_merge" &&
          storedFlow.kind !== "delete" &&
          !recoveryStarted.current
        ) {
          recoveryStarted.current = true
          const recovered = await resumePendingAccountFlow(
            storedFlow,
            currentUser,
          )
          if (recovered) {
            setMergeResult(recovered.merge)
            setNotice("邮箱账号已恢复，记录同步完成。")
            setPending(null)
            savePendingFlow(null)
            await refreshSummary(currentUser)
          }
        }
      } catch (loadError) {
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
  }, [refreshSummary])

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
    if (!pending || otp.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      if (pending.kind === "delete") {
        await verifyAndDeleteAccount(pending, otp)
        setPending(null)
        savePendingFlow(null)
        router.replace("/app")
        return
      }

      const result = await verifyAccountOtp(pending, otp)
      setUser(result.user)
      setMergeResult(result.merge)
      setPending(null)
      savePendingFlow(null)
      setNotice(
        result.merge
          ? "已登录并合并当前浏览器的记录。"
          : "邮箱验证完成，记录已可跨设备恢复。",
      )
      await refreshSummary(result.user)
    } catch (verifyError) {
      setError(friendlyAccountError(verifyError))
    } finally {
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
      const preparedFlow = createPreparedAccountMergeFlow(pending)
      setPending(preparedFlow)
      savePendingFlow(preparedFlow)
      const flow = await confirmAccountMerge(preparedFlow, token)
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
      const nextFlow = await resendAccountOtp(pending, token)
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

  const cancelPending = () => {
    setPending(null)
    setOtp("")
    setNotice(null)
    setError(null)
    savePendingFlow(null)
  }

  const permanent = Boolean(user && !user.is_anonymous && user.email)

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

        <div className="mt-8 overflow-hidden rounded-2xl bg-white shadow-lg shadow-indigo-950/8 lg:grid lg:min-h-[620px] lg:grid-cols-[0.9fr_1.1fr]">
          <section className="bg-indigo-950 px-6 py-8 text-white sm:px-10 sm:py-12 lg:px-12">
            <Badge className="border-indigo-500/50 bg-indigo-900 text-indigo-100 hover:bg-indigo-900">
              {permanent ? "已安全同步" : "可选的长期保存"}
            </Badge>
            <h1 className="mt-6 max-w-lg text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
              {permanent
                ? "你的记录可以跨设备继续。"
                : "先体验，需要时再保存。"}
            </h1>
            <p className="mt-4 max-w-lg text-sm leading-7 text-indigo-200 sm:text-base">
              {permanent
                ? "邮箱只用于验证身份和恢复记录。摄像头画面、人脸关键点和音频仍然不会上传。"
                : "匿名体验仍然是完整产品。绑定邮箱只是让你能在清除浏览器数据或更换设备后找回历史。"}
            </p>
            <div className="mt-10 border-t border-indigo-800 pt-8">
              <FlowRail permanent={permanent} />
            </div>
          </section>

          <section className="px-6 py-8 sm:px-10 sm:py-12 lg:px-14">
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
                    <Turnstile
                      key={`merge-${captchaVersion}`}
                      siteKey={turnstileSiteKey}
                      onSuccess={setCaptchaToken}
                      onExpire={() => setCaptchaToken(undefined)}
                      onError={() => setCaptchaToken(undefined)}
                    />
                  </div>
                ) : null}

                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
                  <Button
                    variant="outline"
                    className="min-h-11 flex-1"
                    onClick={cancelPending}
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
                      autoFocus
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
                    className="px-2 text-slate-600"
                    onClick={cancelPending}
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
                      className="px-2 text-indigo-700"
                      onClick={() => setShowResendChallenge(true)}
                      disabled={busy}
                    >
                      重新获取
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      className="px-2 text-indigo-700"
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
                    <Turnstile
                      key={`resend-${captchaVersion}`}
                      siteKey={turnstileSiteKey}
                      onSuccess={(token) => void resend(token)}
                      onExpire={() => {
                        setShowResendChallenge(false)
                        setError("安全校验已过期，请重新点击重发。")
                      }}
                      onError={() => {
                        setShowResendChallenge(false)
                        setError("安全校验加载失败，请检查网络后重试。")
                      }}
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
                        <AlertDialogCancel>保留账号</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-red-700 hover:bg-red-800"
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
                      <Turnstile
                        key={`delete-${captchaVersion}`}
                        siteKey={turnstileSiteKey}
                        onSuccess={(token) => void requestDeletion(token)}
                        onExpire={() => {
                          setShowDeleteChallenge(false)
                          setError("安全校验已过期，请重新发起删除。")
                        }}
                        onError={() => {
                          setShowDeleteChallenge(false)
                          setError("安全校验加载失败，请检查网络后重试。")
                        }}
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
                      <Turnstile
                        key={`initial-${captchaVersion}`}
                        siteKey={turnstileSiteKey}
                        onSuccess={setCaptchaToken}
                        onExpire={() => setCaptchaToken(undefined)}
                        onError={() => setCaptchaToken(undefined)}
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
