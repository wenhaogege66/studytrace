"use client"

import { useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, type FormEvent } from "react"

import { TurnstileChallenge } from "@/components/auth/turnstile-challenge"
import { useExperience } from "@/components/experience/experience-provider"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  clearRetiredAccountFlowStorage,
  friendlyAccountError,
  maskEmail,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/account"
import {
  authenticatePasswordAccount,
  deletePasswordAccount,
  signOutSafely,
} from "@/lib/auth/account-repository"
import { cn } from "@/lib/utils"

const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

export function AuthScreen() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user, status } = useExperience()
  const permanent = Boolean(user && !user.is_anonymous && user.email)
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_in")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [accepted, setAccepted] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [captchaToken, setCaptchaToken] = useState<string | undefined>()
  const [challengeKey, setChallengeKey] = useState(0)
  const requiresAcknowledgment =
    mode === "sign_up" || deleting || Boolean(user?.is_anonymous)

  useEffect(() => {
    clearRetiredAccountFlowStorage()
  }, [])

  const resetChallenge = () => {
    setCaptchaToken(undefined)
    setChallengeKey((value) => value + 1)
  }

  const finishSwitch = async () => {
    await queryClient.cancelQueries()
    queryClient.clear()
    setPassword("")
    router.replace("/app")
    router.refresh()
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || (requiresAcknowledgment && !accepted)) return
    setBusy(true)
    setError(null)
    try {
      if (deleting) await deletePasswordAccount(password, captchaToken)
      else
        await authenticatePasswordAccount({
          mode,
          email,
          password,
          captchaToken,
        })
      await finishSwitch()
    } catch (cause) {
      setError(friendlyAccountError(cause))
      setPassword("")
      resetChallenge()
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      await signOutSafely()
      await finishSwitch()
    } catch (cause) {
      setError(friendlyAccountError(cause))
    } finally {
      setBusy(false)
    }
  }

  if (status === "checking")
    return (
      <div
        className="mx-auto flex min-h-72 max-w-4xl items-center justify-center gap-2 text-sm text-slate-600"
        role="status"
      >
        <LoaderCircle className="size-4 animate-spin" />
        正在核对账号
      </div>
    )

  return (
    <main className="mx-auto max-w-5xl">
      <Link
        href="/app"
        className="mb-8 inline-flex min-h-11 items-center gap-2 text-sm text-slate-600 hover:text-indigo-700"
      >
        <ArrowLeft className="size-4" />
        返回学习计划
      </Link>
      <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-20">
        <section className="pt-2">
          <p className="section-kicker">账号与记录</p>
          <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight text-balance text-slate-950 sm:text-4xl">
            {permanent
              ? "让每次学习，留下连续的记录。"
              : "让每次学习，连成自己的记录。"}
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-slate-600">
            匿名体验不需要账号。邮箱账号用于长期保存学习计划、学习复盘和学习报告，并在不同设备继续。
          </p>
          <dl className="mt-8 hidden divide-y divide-slate-200/80 border-y border-slate-200/80 lg:block">
            <div className="flex gap-4 py-4">
              <Check className="mt-1 size-4 shrink-0 text-emerald-700" />
              <div>
                <dt className="text-sm font-medium text-slate-900">
                  不需要邮件验证码
                </dt>
                <dd className="mt-1 text-sm leading-6 text-slate-500">
                  邮箱用作账号名；本版不验证邮箱归属，也不提供邮件找回。
                </dd>
              </div>
            </div>
            <div className="flex gap-4 py-4">
              <ShieldCheck className="mt-1 size-4 shrink-0 text-indigo-700" />
              <div>
                <dt className="text-sm font-medium text-slate-900">
                  记录按账号隔离
                </dt>
                <dd className="mt-1 text-sm leading-6 text-slate-500">
                  匿名体验与邮箱账号相互独立，不会自动合并记录。请妥善保存密码。
                </dd>
              </div>
            </div>
          </dl>
        </section>

        <section
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
          aria-label="账号操作"
        >
          {permanent && !deleting ? (
            <>
              <div className="flex size-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                <Cloud className="size-5" />
              </div>
              <h2 className="mt-5 text-xl font-semibold text-slate-950">
                账号已连接
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                {maskEmail(user?.email ?? "")}
              </p>
              <p className="mt-5 text-sm leading-6 text-slate-500">
                记录会保存到当前账号。退出前，正在计时的本次学习会先安全暂停。
              </p>
              <Button className="mt-6 min-h-11 w-full" asChild>
                <Link href="/app">
                  继续学习
                  <ArrowRight />
                </Link>
              </Button>
              <Button
                className="mt-3 min-h-11 w-full"
                variant="outline"
                disabled={busy}
                onClick={() => void signOut()}
              >
                {busy ? <LoaderCircle className="animate-spin" /> : <LogOut />}
                退出账号
              </Button>
              <div className="mt-8 border-t border-slate-100 pt-5">
                <button
                  type="button"
                  className="min-h-11 text-sm text-slate-500 underline-offset-4 hover:text-red-700 hover:underline"
                  onClick={() => {
                    setDeleting(true)
                    setAccepted(false)
                    setError(null)
                    setPassword("")
                    resetChallenge()
                  }}
                >
                  永久删除账号与记录
                </button>
              </div>
            </>
          ) : (
            <>
              {deleting ? (
                <>
                  <h2 className="text-xl font-semibold text-slate-950">
                    永久删除账号与记录
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    重新输入 {maskEmail(user?.email ?? "")}{" "}
                    的密码。学习计划、学习记录和报告将一并删除，此操作无法撤销。
                  </p>
                </>
              ) : (
                <>
                  <div
                    className="grid grid-cols-2 border-b border-slate-200"
                    role="group"
                    aria-label="账号方式"
                  >
                    {(
                      [
                        ["sign_in", "登录"],
                        ["sign_up", "注册"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={mode === value}
                        disabled={busy}
                        onClick={() => {
                          setMode(value)
                          setError(null)
                          setPassword("")
                          setAccepted(false)
                          resetChallenge()
                        }}
                        className={cn(
                          "min-h-12 border-b-2 border-transparent pb-3 text-sm font-medium text-slate-500",
                          mode === value && "border-indigo-700 text-indigo-700",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <h2 className="mt-6 text-xl font-semibold text-slate-950">
                    {mode === "sign_up" ? "创建独立邮箱账号" : "欢迎回来"}
                  </h2>
                  {user?.is_anonymous ? (
                    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                      当前是临时体验。{mode === "sign_up" ? "注册" : "登录"}
                      成功后将切换到独立账号，临时记录不会迁入，也无法直接找回。请先导出需要保留的记录；验证失败不会切换身份。
                      <Link
                        href="/app/settings"
                        className="ml-1 underline underline-offset-4"
                      >
                        前往设置导出
                      </Link>
                    </p>
                  ) : null}
                </>
              )}
              <form
                className="mt-6 space-y-5"
                onSubmit={(event) => void submit(event)}
              >
                {!deleting ? (
                  <div className="space-y-2">
                    <Label htmlFor="account-email">邮箱</Label>
                    <Input
                      id="account-email"
                      type="email"
                      autoComplete="username"
                      required
                      maxLength={254}
                      value={email}
                      disabled={busy}
                      onChange={(event) => setEmail(event.target.value)}
                      className="min-h-11"
                      placeholder="you@example.com"
                    />
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="account-password">
                    {deleting ? "再次输入密码" : "密码"}
                  </Label>
                  <Input
                    id="account-password"
                    type="password"
                    autoComplete={
                      mode === "sign_up" && !deleting
                        ? "new-password"
                        : "current-password"
                    }
                    minLength={MIN_PASSWORD_LENGTH}
                    required
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                    className="min-h-11"
                    aria-describedby="password-help"
                  />
                  <p
                    id="password-help"
                    className="text-xs leading-5 text-slate-500"
                  >
                    至少 8 个字符。本版没有邮件找回，请保存好密码。
                  </p>
                </div>
                {requiresAcknowledgment ? (
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6 text-slate-600">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-indigo-700"
                      checked={accepted}
                      disabled={busy}
                      required
                      onChange={(event) => setAccepted(event.target.checked)}
                    />
                    {deleting
                      ? "我理解全部账号记录将被永久删除，且无法恢复。"
                      : user?.is_anonymous
                        ? "我已保留需要的临时记录，理解切换后不会迁入新账号；本版不验证邮箱归属，也没有邮件找回。"
                        : "我理解邮箱不做归属验证、密码无法通过邮件找回。"}
                  </label>
                ) : null}
                {turnstileSiteKey ? (
                  <TurnstileChallenge
                    key={challengeKey}
                    siteKey={turnstileSiteKey}
                    onSuccess={(token) => setCaptchaToken(token)}
                    onInvalidate={() => setCaptchaToken(undefined)}
                  />
                ) : null}
                {error ? (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                <Button
                  type="submit"
                  className="min-h-11 w-full"
                  variant={deleting ? "destructive" : "default"}
                  disabled={
                    busy ||
                    Boolean(turnstileSiteKey && !captchaToken) ||
                    (requiresAcknowledgment && !accepted)
                  }
                >
                  {busy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : deleting ? (
                    <Trash2 />
                  ) : (
                    <ArrowRight />
                  )}
                  {busy
                    ? "正在处理"
                    : deleting
                      ? "验证密码并永久删除"
                      : mode === "sign_up"
                        ? "注册并进入学习计划"
                        : "登录并进入学习计划"}
                </Button>
              </form>
              {deleting ? (
                <Button
                  variant="ghost"
                  className="mt-3 min-h-11 w-full"
                  disabled={busy}
                  onClick={() => {
                    setDeleting(false)
                    setPassword("")
                    setError(null)
                  }}
                >
                  取消删除
                </Button>
              ) : (
                <p className="mt-6 text-center">
                  <Link
                    href="/app"
                    className="inline-flex min-h-11 items-center text-sm font-medium text-indigo-700"
                  >
                    {user?.is_anonymous ? "继续临时体验" : "直接匿名体验"}
                    <ArrowRight className="ml-2 size-4" />
                  </Link>
                </p>
              )}
            </>
          )}
          {permanent && !deleting && error ? (
            <Alert className="mt-4" variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </section>
      </div>
    </main>
  )
}
