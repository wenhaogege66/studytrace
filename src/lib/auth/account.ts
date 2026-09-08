import type { AuthError } from "@supabase/supabase-js"

export const ACCOUNT_FLOW_STORAGE_KEY = "studytrace.pending-account-flow.v1"
export const ACCOUNT_MERGE_RECOVERY_STORAGE_KEY =
  "studytrace.pending-account-merge-recovery.v1"
export const ACCOUNT_MERGE_HANDOFF_MARKER_KEY =
  "studytrace.account-merge-handoff.v1"
export const ACCOUNT_MERGE_DURABLE_FLOW_STORAGE_KEY =
  "studytrace.pending-account-merge-durable.v2"
export const OTP_RESEND_SECONDS = 60
export const ACCOUNT_MERGE_PREPARED_TTL_MS = 10 * 60 * 1_000

export type AccountFlowKind =
  "upgrade" | "confirm_merge" | "merge" | "sign_in" | "delete"

export type PendingAccountFlow = {
  kind: AccountFlowKind
  email: string
  sentAt: number
  preparedAt?: number
  sourceUserId?: string
  mergeSecret?: string
  mergeTargetUserId?: string
  deletionSecret?: string
  mergeRecoveryRequired?: boolean
}

export type AccountMergeRecovery = {
  sourceUserId: string
  targetUserId: string
  email: string
  accessToken: string
  refreshToken: string
  capturedAt: number
}

export type AccountMergeHandoffMarker = {
  sourceUserId: string
  targetUserId?: string
  email: string
  capturedAt: number
}

export type AccountMergeDurableFlow = {
  sourceUserId: string
  targetUserId?: string
  email: string
  mergeSecret: string
  preparedAt: number
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
    const flowTtl = candidate.mergeRecoveryRequired
      ? 30 * 60 * 1_000
      : 10 * 60 * 1_000
    if (!lastActionAt || Date.now() - lastActionAt >= flowTtl) {
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
    if (candidate.mergeTargetUserId !== undefined) {
      if (
        typeof candidate.mergeTargetUserId !== "string" ||
        !candidate.mergeTargetUserId ||
        candidate.mergeTargetUserId === flow.sourceUserId
      ) {
        return null
      }
      flow.mergeTargetUserId = candidate.mergeTargetUserId
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
    if (candidate.mergeRecoveryRequired !== undefined) {
      if (typeof candidate.mergeRecoveryRequired !== "boolean") return null
      flow.mergeRecoveryRequired = candidate.mergeRecoveryRequired
    }
    if (
      (flow.kind === "merge" && (!flow.sourceUserId || !flow.mergeSecret)) ||
      (flow.kind === "confirm_merge" && !flow.sourceUserId) ||
      (flow.kind === "delete" && !flow.deletionSecret) ||
      (flow.mergeTargetUserId !== undefined && flow.kind !== "merge") ||
      (flow.mergeRecoveryRequired && flow.kind !== "merge")
    ) {
      return null
    }
    return flow
  } catch {
    return null
  }
}

export function serializeAnonymousMergeRecovery(
  recovery: AccountMergeRecovery,
) {
  return JSON.stringify(recovery)
}

export function parseAnonymousMergeRecovery(
  value: string | null,
): AccountMergeRecovery | null {
  if (!value) return null
  try {
    const candidate = JSON.parse(value) as Partial<AccountMergeRecovery>
    if (
      typeof candidate.sourceUserId !== "string" ||
      !candidate.sourceUserId ||
      typeof candidate.targetUserId !== "string" ||
      !candidate.targetUserId ||
      candidate.targetUserId === candidate.sourceUserId ||
      typeof candidate.email !== "string" ||
      typeof candidate.accessToken !== "string" ||
      !candidate.accessToken ||
      typeof candidate.refreshToken !== "string" ||
      !candidate.refreshToken ||
      typeof candidate.capturedAt !== "number" ||
      !Number.isFinite(candidate.capturedAt) ||
      candidate.capturedAt <= 0 ||
      candidate.capturedAt > Date.now() + 5 * 60_000
    ) {
      return null
    }
    return {
      sourceUserId: candidate.sourceUserId,
      targetUserId: candidate.targetUserId,
      email: normalizeEmail(candidate.email),
      accessToken: candidate.accessToken,
      refreshToken: candidate.refreshToken,
      capturedAt: candidate.capturedAt,
    }
  } catch {
    return null
  }
}

export function serializeAccountMergeHandoffMarker(
  marker: AccountMergeHandoffMarker,
) {
  return JSON.stringify(marker)
}

export function serializeAccountMergeDurableFlow(
  flow: AccountMergeDurableFlow,
) {
  return JSON.stringify(flow)
}

export function parseAccountMergeDurableFlow(
  value: string | null,
): AccountMergeDurableFlow | null {
  if (!value) return null
  try {
    const candidate = JSON.parse(value) as Partial<AccountMergeDurableFlow>
    if (
      typeof candidate.sourceUserId !== "string" ||
      !candidate.sourceUserId ||
      typeof candidate.email !== "string" ||
      typeof candidate.mergeSecret !== "string" ||
      !/^[a-f0-9]{64}$/i.test(candidate.mergeSecret) ||
      typeof candidate.preparedAt !== "number" ||
      !Number.isFinite(candidate.preparedAt) ||
      candidate.preparedAt <= 0 ||
      candidate.preparedAt > Date.now() + 5 * 60_000 ||
      Date.now() - candidate.preparedAt >= ACCOUNT_MERGE_PREPARED_TTL_MS ||
      (candidate.targetUserId !== undefined &&
        (typeof candidate.targetUserId !== "string" ||
          !candidate.targetUserId ||
          candidate.targetUserId === candidate.sourceUserId))
    ) {
      return null
    }
    return {
      sourceUserId: candidate.sourceUserId,
      ...(candidate.targetUserId
        ? { targetUserId: candidate.targetUserId }
        : {}),
      email: normalizeEmail(candidate.email),
      mergeSecret: candidate.mergeSecret,
      preparedAt: candidate.preparedAt,
    }
  } catch {
    return null
  }
}

export function pendingMergeFromDurableFlow(
  marker: AccountMergeDurableFlow,
): PendingAccountFlow {
  return {
    kind: "merge",
    email: marker.email,
    sentAt: 0,
    preparedAt: marker.preparedAt,
    sourceUserId: marker.sourceUserId,
    mergeSecret: marker.mergeSecret,
    ...(marker.targetUserId ? { mergeTargetUserId: marker.targetUserId } : {}),
  }
}

export function parseAccountMergeHandoffMarker(
  value: string | null,
): AccountMergeHandoffMarker | null {
  if (!value) return null
  try {
    const candidate = JSON.parse(value) as Partial<AccountMergeHandoffMarker>
    if (
      typeof candidate.sourceUserId !== "string" ||
      !candidate.sourceUserId ||
      (candidate.targetUserId !== undefined &&
        (typeof candidate.targetUserId !== "string" ||
          !candidate.targetUserId ||
          candidate.targetUserId === candidate.sourceUserId)) ||
      typeof candidate.email !== "string" ||
      typeof candidate.capturedAt !== "number" ||
      !Number.isFinite(candidate.capturedAt) ||
      candidate.capturedAt <= 0 ||
      candidate.capturedAt > Date.now() + 5 * 60_000 ||
      Date.now() - candidate.capturedAt > 24 * 60 * 60_000
    ) {
      return null
    }
    return {
      sourceUserId: candidate.sourceUserId,
      ...(candidate.targetUserId
        ? { targetUserId: candidate.targetUserId }
        : {}),
      email: normalizeEmail(candidate.email),
      capturedAt: candidate.capturedAt,
    }
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
  if (
    message.includes("another account merge") ||
    message.includes("another account deletion")
  )
    return "已有一项账号验证正在进行，请先完成或取消后再试"
  if (message.includes("merge request is invalid or expired"))
    return "本次记录合并已过期，请重新发起"
  if (message.includes("deletion verification is invalid or expired"))
    return "本次账号删除验证已过期，请重新发起"
  if (message.includes("account merge would exceed"))
    return "合并后的记录数量会超过当前上限，请先清理部分历史记录"
  if (message.includes("fresh") && message.includes("otp verification"))
    return "为保护数据，请先重新完成邮箱验证码验证"
  if (
    message.includes("account merge request changed") ||
    message.includes("anonymous source account changed") ||
    message.includes("only an anonymous account can prepare a merge")
  )
    return "当前匿名记录已发生变化，请重新发起合并"
  if (message.includes("anonymous source account no longer exists"))
    return "当前匿名记录已不存在，请重新开始体验"
  if (
    message.includes("authentication required") ||
    message.includes("current anonymous session is required") ||
    message.includes("current account session is required") ||
    message.includes("current permanent account is required")
  )
    return "当前账号会话已失效，请重新进入账号页后再试"
  if (message.includes("verified permanent account is required"))
    return "请先登录并完成邮箱验证"
  if (
    message.includes("invalid account merge secret") ||
    message.includes("invalid account deletion secret")
  )
    return "本次验证凭证无效，请重新发起"
  if (
    message.includes("gateway timeout") ||
    message.includes("service unavailable") ||
    message.includes("request timeout")
  )
    return "服务响应暂时中断，请保留当前页面并重试"
  if (message.includes("failed to fetch") || message.includes("fetch failed"))
    return "网络连接失败，请检查网络后重试"
  if (message.includes("记录合并流程已在其他标签页取消或改变"))
    return "记录合并流程已在其他标签页取消或改变，请重新发起"
  if (message.includes("记录合并流程已在其他标签页改变"))
    return "记录合并流程已在其他标签页改变，本次验证码不会继续使用旧凭证"
  if (message.includes("当前账号已在其他标签页改变"))
    return "当前账号已在其他标签页改变，请重新验证目标邮箱"
  if (message.includes("合并结果格式异常"))
    return "合并结果格式异常，请保留当前页面并重试确认"
  if (
    message.includes("待同步记录格式异常") ||
    message.includes("记录合并恢复凭证与当前流程不匹配")
  )
    return "本次记录合并状态异常，请重新核对后再试"
  if (message.includes("账号删除流程已失效"))
    return "本次账号删除流程已失效，请重新发起"

  return "操作未完成，请稍后重试；如果问题持续，请重新打开账号页"
}
