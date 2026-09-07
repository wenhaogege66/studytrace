import type { AuthError } from "@supabase/supabase-js"

export const ACCOUNT_FLOW_STORAGE_KEY = "studytrace.pending-account-flow.v1"
export const OTP_RESEND_SECONDS = 60

export type AccountFlowKind =
  "upgrade" | "confirm_merge" | "merge" | "sign_in" | "delete"

export type PendingAccountFlow = {
  kind: AccountFlowKind
  email: string
  sentAt: number
  preparedAt?: number
  sourceUserId?: string
  mergeSecret?: string
  deletionSecret?: string
}

export type AccountTransferSummary = {
  tasks: number
  sessions: number
  behaviorEvents: number
  reviews: number
  hasActiveSession: boolean
}

export type AccountMergeResult = {
  tasks: number
  sessions: number
  behaviorEvents: number
  reminderEvents: number
  reviews: number
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLocaleLowerCase("en-US")
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error("请输入有效的邮箱地址")
  }
  return email
}

export function normalizeOtp(value: string) {
  return value.replace(/\D/g, "").slice(0, 6)
}

export function maskEmail(value: string) {
  const email = normalizeEmail(value)
  const [local, domain] = email.split("@")
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}@${domain}`
}

export function createMergeSecret(
  cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
) {
  const bytes = new Uint8Array(32)
  cryptoSource.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  )
}

export function serializePendingAccountFlow(flow: PendingAccountFlow) {
  return JSON.stringify(flow)
}

export function parsePendingAccountFlow(
  value: string | null,
): PendingAccountFlow | null {
  if (!value) return null

  try {
    const candidate = JSON.parse(value) as Partial<PendingAccountFlow>
    if (
      !["upgrade", "confirm_merge", "merge", "sign_in", "delete"].includes(
        candidate.kind ?? "",
      ) ||
      typeof candidate.email !== "string" ||
      typeof candidate.sentAt !== "number" ||
      !Number.isFinite(candidate.sentAt)
    ) {
      return null
    }

    if (
      candidate.preparedAt !== undefined &&
      (typeof candidate.preparedAt !== "number" ||
        !Number.isFinite(candidate.preparedAt))
    ) {
      return null
    }

    const lastActionAt = candidate.sentAt || candidate.preparedAt || 0
    if (!lastActionAt || Date.now() - lastActionAt >= 10 * 60 * 1000) {
      return null
    }

    const flow: PendingAccountFlow = {
      kind: candidate.kind as AccountFlowKind,
      email: normalizeEmail(candidate.email),
      sentAt: candidate.sentAt,
    }

    if (candidate.preparedAt !== undefined) {
      flow.preparedAt = candidate.preparedAt
    }

    if (candidate.sourceUserId !== undefined) {
      if (typeof candidate.sourceUserId !== "string") return null
      flow.sourceUserId = candidate.sourceUserId
    }
    if (candidate.mergeSecret !== undefined) {
      if (
        typeof candidate.mergeSecret !== "string" ||
        !/^[a-f0-9]{64}$/i.test(candidate.mergeSecret)
      ) {
        return null
      }
      flow.mergeSecret = candidate.mergeSecret
    }
    if (candidate.deletionSecret !== undefined) {
      if (
        typeof candidate.deletionSecret !== "string" ||
        !/^[a-f0-9]{64}$/i.test(candidate.deletionSecret)
      ) {
        return null
      }
      flow.deletionSecret = candidate.deletionSecret
    }
    if (
      (flow.kind === "merge" && (!flow.sourceUserId || !flow.mergeSecret)) ||
      (flow.kind === "confirm_merge" && !flow.sourceUserId) ||
      (flow.kind === "delete" && !flow.deletionSecret)
    ) {
      return null
    }
    return flow
  } catch {
    return null
  }
}

export function isExistingEmailError(error: Pick<AuthError, "code">) {
  return [
    "email_exists",
    "identity_already_exists",
    "user_already_exists",
  ].includes(error.code ?? "")
}

export function friendlyAccountError(error: unknown) {
  if (!(error instanceof Error)) return "操作失败，请稍后重试"

  const code = "code" in error ? String(error.code ?? "") : ""
  const message = error.message.toLocaleLowerCase("en-US")

  if (code === "over_email_send_rate_limit")
    return "验证码发送太频繁，请稍后再试"
  if (code === "email_address_not_authorized")
    return "当前邮件服务尚未允许向这个地址发送，请联系项目管理员检查 SMTP 配置"
  if (code === "captcha_failed") return "安全校验已失效，请重新完成校验"
  if (code === "otp_expired") return "验证码错误或已过期，请重新获取"
  if (code === "invalid_credentials") return "验证码错误或账号不存在"
  if (code === "manual_linking_disabled")
    return "项目尚未开启身份绑定，请联系项目管理员"
  if (
    message.includes("active study session") ||
    message.includes("current study session")
  )
    return "请先结束当前学习时段，再合并到已有账号"
  if (message.includes("merge request is invalid or expired"))
    return "本次记录合并已过期，请重新发起"
  if (message.includes("fresh email verification"))
    return "为保护数据，请先重新完成邮箱验证"
  if (message.includes("failed to fetch") || message.includes("fetch failed"))
    return "网络连接失败，请检查网络后重试"

  return error.message
}
