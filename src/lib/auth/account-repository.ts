import type { User } from "@supabase/supabase-js"

import {
  ACCOUNT_MERGE_PREPARED_TTL_MS,
  createMergeSecret,
  isExistingEmailError,
  normalizeEmail,
  type AccountMergeRecovery,
  type AccountTransferSummary,
  type PendingAccountFlow,
} from "@/lib/auth/account"
import { ensureSettings } from "@/lib/data/study-repository"
import {
  createTransientSupabase,
  getSupabase,
  withSupabaseAuthMutationLock,
} from "@/lib/supabase/client"
import type { Json } from "@/types/database"

type DataError = { code?: string; message: string }
type JsonObject = { [key: string]: Json | undefined }
const MERGE_RESEND_MIN_VALIDITY_MS = 120_000

function assertRpc<T>(
  response: { data: T | null; error: DataError | null },
  fallback: string,
) {
  if (response.error)
    throw Object.assign(new Error(response.error.message), response.error)
  if (response.data === null) throw new Error(fallback)
  return response.data
}

function assertRpcSuccess(response: { error: DataError | null }) {
  if (response.error)
    throw Object.assign(new Error(response.error.message), response.error)
}

function assertJsonObject(value: Json, fallback: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(fallback)
  }
  return value
}

function asCount(value: Json | undefined) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
}

export function isDefinitiveAccountRpcRollback(error: unknown) {
  if (!(error instanceof Error) || !("code" in error)) return false
  const code = String(error.code ?? "").toLocaleUpperCase("en-US")
  return (
    /^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08") && code !== "40003"
  )
}

type MergeAttemptOutcome =
  "result_uncertain" | "source_restored" | "target_reverification_required"

function mergeAttemptError(error: unknown, outcome: MergeAttemptOutcome) {
  const original = error instanceof Error ? error : new Error(String(error))
  return Object.assign(new Error(original.message, { cause: original }), {
    ...(typeof (original as DataError).code === "string"
      ? { code: (original as DataError).code }
      : {}),
    mergeAttemptOutcome: outcome,
  })
}

export function isMergeResultUncertain(error: unknown) {
  return (
    error instanceof Error &&
    "mergeAttemptOutcome" in error &&
    error.mergeAttemptOutcome === "result_uncertain"
  )
}

export function isMergeSourceRestored(error: unknown) {
  return (
    error instanceof Error &&
    "mergeAttemptOutcome" in error &&
    error.mergeAttemptOutcome === "source_restored"
  )
}

export function isMergeTargetReverificationRequired(error: unknown) {
  return (
    error instanceof Error &&
    "mergeAttemptOutcome" in error &&
    error.mergeAttemptOutcome === "target_reverification_required"
  )
}

export function isDefinitivelyMissingAuthUser(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? String(error.code ?? "") : ""
  const status = "status" in error ? Number(error.status) : 0
  const message = error.message.toLocaleLowerCase("en-US")
  return (
    code === "user_not_found" ||
    ((status === 401 || status === 403) &&
      (message.includes("user from sub claim") ||
        message.includes("user does not exist") ||
        message.includes("user not found")))
  )
}

export async function clearDefinitivelyStaleAuthSession(
  expectedUserId: string | null,
): Promise<"cleared" | "changed" | "valid"> {
  return withSupabaseAuthMutationLock(async () => {
    const supabase = getSupabase()
    const { data: cached, error: sessionError } =
      await supabase.auth.getSession()
    if (sessionError) {
      if (!isDefinitivelyMissingAuthUser(sessionError)) throw sessionError
      const { error: signOutError } = await supabase.auth.signOut({
        scope: "local",
      })
      if (signOutError) throw signOutError
      return "cleared"
    }

    const cachedUser = cached.session?.user
    if (!expectedUserId || !cachedUser || cachedUser.id !== expectedUserId) {
      return "changed"
    }

    const { data: verified, error: verificationError } =
      await supabase.auth.getUser()
    if (verificationError) {
      if (!isDefinitivelyMissingAuthUser(verificationError)) {
        throw verificationError
      }
      const { error: signOutError } = await supabase.auth.signOut({
        scope: "local",
      })
      if (signOutError) throw signOutError
      return "cleared"
    }
    return verified.user?.id === expectedUserId ? "valid" : "changed"
  })
}

async function inspectMergeSource(flow: PendingAccountFlow) {
  const supabase = getSupabase()
  const { data: cached, error: sessionError } = await supabase.auth.getSession()
  if (
    sessionError ||
    !cached.session?.user.is_anonymous ||
    cached.session.user.id !== flow.sourceUserId
  ) {
    return "unknown"
  }

  const { data, error } = await supabase.auth.getUser()
  if (error) {
    return isDefinitivelyMissingAuthUser(error) ? "missing" : "unknown"
  }
  return data.user?.is_anonymous && data.user.id === flow.sourceUserId
    ? "valid"
    : "unknown"
}

async function revokeTransientSessionBestEffort(
  transient: ReturnType<typeof createTransientSupabase>,
) {
  try {
    await transient.auth.signOut({ scope: "local" })
  } catch {
    // Session-table hygiene only. Never replace the primary recovery result
    // with a cleanup error or retry this on an uncertain merge response.
  }
}

function validateMergeRecovery(
  flow: PendingAccountFlow,
  recovery: AccountMergeRecovery | null | undefined,
) {
  if (
    flow.kind !== "merge" ||
    !flow.sourceUserId ||
    !flow.mergeSecret ||
    !recovery ||
    recovery.sourceUserId !== flow.sourceUserId ||
    recovery.email !== flow.email ||
    (flow.mergeTargetUserId !== undefined &&
      recovery.targetUserId !== flow.mergeTargetUserId)
  ) {
    throw new Error("记录合并恢复凭证与当前流程不匹配")
  }
  return recovery
}

async function openTransientTargetSession(recovery: AccountMergeRecovery) {
  const transient = createTransientSupabase()
  const { data, error } = await transient.auth.setSession({
    access_token: recovery.accessToken,
    refresh_token: recovery.refreshToken,
  })
  const session = data.session
  const user = session?.user
  if (error) throw error
  if (
    !user ||
    user.is_anonymous ||
    user.id !== recovery.targetUserId ||
    !user.email ||
    normalizeEmail(user.email) !== recovery.email ||
    !session.access_token ||
    !session.refresh_token
  ) {
    await revokeTransientSessionBestEffort(transient)
    throw new Error("目标邮箱会话与本次合并不匹配")
  }
  return {
    transient,
    user,
    recovery: {
      ...recovery,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      capturedAt: Date.now(),
    },
  }
}

function isMatchingTargetUser(
  user: User | null | undefined,
  recovery: AccountMergeRecovery,
) {
  return Boolean(
    user &&
    !user.is_anonymous &&
    user.id === recovery.targetUserId &&
    user.email &&
    normalizeEmail(user.email) === recovery.email,
  )
}

async function commitTargetSession(recovery: AccountMergeRecovery) {
  return withSupabaseAuthMutationLock(async () => {
    const supabase = getSupabase()
    const { data: current, error: currentError } =
      await supabase.auth.getSession()
    if (currentError) throw currentError
    const currentUser = current.session?.user

    if (isMatchingTargetUser(currentUser, recovery)) {
      const { data: verified, error: verificationError } =
        await supabase.auth.getUser()
      if (verificationError) throw verificationError
      if (!isMatchingTargetUser(verified.user, recovery)) {
        throw new Error("当前邮箱账号验证结果不一致，已停止切换")
      }
      return verified.user as User
    }

    if (
      !currentUser ||
      !currentUser.is_anonymous ||
      currentUser.id !== recovery.sourceUserId
    ) {
      throw new Error("当前账号已改变，请重新验证目标邮箱后继续")
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: recovery.accessToken,
      refresh_token: recovery.refreshToken,
    })
    const user = data.session?.user
    if (error) throw error
    if (!isMatchingTargetUser(user, recovery)) {
      throw new Error("无法安全切换到已验证的邮箱账号")
    }

    const { data: committed, error: committedError } =
      await supabase.auth.getSession()
    if (
      committedError ||
      !isMatchingTargetUser(committed.session?.user, recovery)
    ) {
      throw committedError ?? new Error("邮箱账号会话确认失败")
    }
    return committed.session?.user as User
  })
}

export async function touchMyActivity() {
  const response = await getSupabase().rpc("touch_my_activity")
  return assertRpc(response, "更新活动时间失败")
}

export async function getAccountTransferSummary(): Promise<AccountTransferSummary> {
  const raw = assertJsonObject(
    assertRpc(
      await getSupabase().rpc("get_my_account_transfer_summary"),
      "读取待同步记录失败",
    ),
    "待同步记录格式异常",
  )
  return {
    tasks: asCount(raw.tasks),
    sessions: asCount(raw.sessions),
    behaviorEvents: asCount(raw.behavior_events),
    reviews: asCount(raw.reviews),
    hasActiveSession: raw.has_active_session === true,
  }
}

export async function beginEmailAccountFlow(
  emailValue: string,
  captchaToken?: string,
): Promise<PendingAccountFlow> {
  return withSupabaseAuthMutationLock(async () => {
    const email = normalizeEmail(emailValue)
    const supabase = getSupabase()
    const { data: sessionData, error: sessionError } =
      await supabase.auth.getSession()
    if (sessionError) throw sessionError

    const currentUser = sessionData.session?.user ?? null
    if (currentUser?.is_anonymous) {
      const { error: upgradeError } = await supabase.auth.updateUser({ email })
      if (!upgradeError) {
        return {
          kind: "upgrade",
          email,
          sentAt: Date.now(),
          sourceUserId: currentUser.id,
        }
      }

      if (!isExistingEmailError(upgradeError)) throw upgradeError

      return {
        kind: "confirm_merge",
        email,
        sentAt: Date.now(),
        sourceUserId: currentUser.id,
      }
    }

    if (currentUser) {
      throw new Error("当前已是可同步账号")
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, captchaToken },
    })
    if (error) throw error

    return { kind: "sign_in", email, sentAt: Date.now() }
  })
}

export async function confirmAccountMerge(
  flow: PendingAccountFlow,
  captchaToken?: string,
  onPrepared?: (flow: PendingAccountFlow) => Promise<void> | void,
): Promise<PendingAccountFlow> {
  if (flow.kind !== "merge" || !flow.sourceUserId || !flow.mergeSecret) {
    throw new Error("记录合并确认已失效")
  }

  const supabase = getSupabase()
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession()
  if (sessionError) throw sessionError
  const currentUser = sessionData.session?.user
  if (!currentUser?.is_anonymous || currentUser.id !== flow.sourceUserId) {
    throw new Error("当前匿名记录已改变，请重新发起合并")
  }

  assertRpc(
    await getSupabase().rpc("prepare_account_merge", {
      p_token: flow.mergeSecret,
      p_target_email: flow.email,
    }),
    "准备记录合并失败",
  )
  await onPrepared?.(flow)

  const { error: otpError } =
    await createTransientSupabase().auth.signInWithOtp({
      email: flow.email,
      options: { shouldCreateUser: false, captchaToken },
    })
  if (otpError) throw otpError

  return { ...flow, sentAt: Date.now() }
}

export function createPreparedAccountMergeFlow(
  flow: PendingAccountFlow,
): PendingAccountFlow {
  if (flow.kind !== "confirm_merge" || !flow.sourceUserId) {
    throw new Error("记录合并确认已失效")
  }
  return {
    kind: "merge",
    email: flow.email,
    sentAt: 0,
    preparedAt: Date.now(),
    sourceUserId: flow.sourceUserId,
    mergeSecret: createMergeSecret(),
  }
}

export async function resendAccountOtp(
  flow: PendingAccountFlow,
  captchaToken?: string,
) {
  if (flow.kind === "confirm_merge") {
    throw new Error("请先确认是否合并当前匿名记录")
  }
  const supabase = getSupabase()
  if (flow.kind === "upgrade") {
    const { error } = await supabase.auth.resend({
      type: "email_change",
      email: flow.email,
      options: { captchaToken },
    })
    if (error) throw error
    return { ...flow, sentAt: Date.now() }
  }

  if (flow.kind === "merge") {
    if (!flow.mergeSecret) throw new Error("记录合并凭证已丢失")
    if (
      !flow.preparedAt ||
      Date.now() - flow.preparedAt >=
        ACCOUNT_MERGE_PREPARED_TTL_MS - MERGE_RESEND_MIN_VALIDITY_MS
    ) {
      throw new Error("记录合并请求即将过期，请重新发起")
    }
    const { data: sourceSession, error: sourceSessionError } =
      await getSupabase().auth.getSession()
    if (
      !sourceSessionError &&
      sourceSession.session?.user.is_anonymous &&
      sourceSession.session.user.id === flow.sourceUserId
    ) {
      assertRpc(
        await getSupabase().rpc("prepare_account_merge", {
          p_token: flow.mergeSecret,
          p_target_email: flow.email,
        }),
        "重新确认记录合并请求失败",
      )
    }
  } else if (flow.kind === "delete") {
    if (!flow.deletionSecret) throw new Error("删除验证凭证已丢失")
    assertRpc(
      await getSupabase().rpc("refresh_account_deletion", {
        p_token: flow.deletionSecret,
      }),
      "刷新删除验证请求失败",
    )
  }

  const otpClient = flow.kind === "merge" ? createTransientSupabase() : supabase
  const { error } = await otpClient.auth.signInWithOtp({
    email: flow.email,
    options: { shouldCreateUser: false, captchaToken },
  })
  if (error) throw error
  return { ...flow, sentAt: Date.now() }
}

export async function cancelPendingAccountFlow(flow: PendingAccountFlow) {
  if (flow.kind === "merge" && flow.mergeSecret) {
    return assertRpc(
      await getSupabase().rpc("cancel_account_merge", {
        p_token: flow.mergeSecret,
      }),
      "取消记录合并失败",
    )
  }

  if (flow.kind === "delete" && flow.deletionSecret) {
    return assertRpc(
      await getSupabase().rpc("cancel_account_deletion", {
        p_token: flow.deletionSecret,
      }),
      "取消账号删除失败",
    )
  }

  return true
}

export async function verifyAccountOtp(
  flow: PendingAccountFlow,
  token: string,
  onMergeTargetReady?: (recovery: AccountMergeRecovery) => Promise<void> | void,
) {
  if (flow.kind === "confirm_merge") {
    throw new Error("请先确认并发送验证码")
  }

  if (flow.kind === "merge") {
    if (!flow.sourceUserId || !flow.mergeSecret) {
      throw new Error("记录合并确认已失效")
    }
    const transient = createTransientSupabase()
    const { data, error } = await transient.auth.verifyOtp({
      email: flow.email,
      token,
      type: "email",
    })
    if (error) throw error
    if (
      !data.user ||
      data.user.is_anonymous ||
      !data.user.email ||
      normalizeEmail(data.user.email) !== flow.email ||
      (flow.mergeTargetUserId !== undefined &&
        data.user.id !== flow.mergeTargetUserId) ||
      !data.session?.access_token ||
      !data.session.refresh_token
    ) {
      await revokeTransientSessionBestEffort(transient)
      throw new Error("无法确认记录合并身份")
    }

    const recovery: AccountMergeRecovery = {
      sourceUserId: flow.sourceUserId,
      targetUserId: data.user.id,
      email: flow.email,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      capturedAt: Date.now(),
    }
    try {
      await onMergeTargetReady?.(recovery)
    } catch (callbackError) {
      await revokeTransientSessionBestEffort(transient)
      throw callbackError
    }

    let raw: JsonObject
    try {
      raw = assertJsonObject(
        assertRpc(
          await transient.rpc("consume_account_merge", {
            p_token: flow.mergeSecret,
          }),
          "合并匿名记录失败",
        ),
        "合并结果格式异常",
      )
    } catch (mergeError) {
      if (isDefinitiveAccountRpcRollback(mergeError)) {
        const sourceState = await inspectMergeSource(flow)
        if (sourceState === "valid") {
          await revokeTransientSessionBestEffort(transient)
          throw mergeAttemptError(mergeError, "source_restored")
        }
        if (sourceState === "missing") {
          try {
            const committedUser = await commitTargetSession(recovery)
            return {
              user: committedUser,
              merge: null,
              recoveredWithoutReceipt: true,
            }
          } catch (sessionError) {
            throw mergeAttemptError(
              sessionError,
              "target_reverification_required",
            )
          }
        }
      }
      throw mergeAttemptError(mergeError, "result_uncertain")
    }

    let user: User
    try {
      user = await commitTargetSession(recovery)
    } catch (sessionError) {
      // The merge RPC returned a canonical receipt, so the database commit is
      // known. Only the local session handoff remains; require fresh target
      // OTP rather than retrying an already-completed database mutation.
      throw mergeAttemptError(sessionError, "target_reverification_required")
    }

    return {
      user,
      merge: {
        tasks: asCount(raw.tasks),
        sessions: asCount(raw.sessions),
        behaviorEvents: asCount(raw.behavior_events),
        reminderEvents: asCount(raw.reminder_events),
        reviews: asCount(raw.reviews),
      },
      recoveredWithoutReceipt: false,
    }
  }

  return withSupabaseAuthMutationLock(async () => {
    const supabase = getSupabase()
    const type = flow.kind === "upgrade" ? "email_change" : "email"
    const { data, error } = await supabase.auth.verifyOtp({
      email: flow.email,
      token,
      type,
    })
    if (error) throw error
    if (!data.user) throw new Error("验证成功后未获得账号信息")

    if (flow.kind === "upgrade") {
      if (!flow.sourceUserId || data.user.id !== flow.sourceUserId) {
        throw new Error("邮箱绑定后账号标识异常，已停止继续")
      }
      if (data.user.is_anonymous) {
        throw new Error("邮箱尚未完成绑定，请重新获取验证码")
      }
    }

    if (flow.kind !== "delete") await ensureSettings(data.user.id)
    await touchMyActivity()
    return { user: data.user, merge: null, recoveredWithoutReceipt: false }
  })
}

export async function requestAccountDeletionOtp(
  user: User,
  flow: PendingAccountFlow,
  captchaToken?: string,
): Promise<PendingAccountFlow> {
  if (user.is_anonymous || !user.email) {
    throw new Error("只有已绑定邮箱的账号可以执行此操作")
  }
  const email = normalizeEmail(user.email)
  if (flow.kind !== "delete" || flow.email !== email || !flow.deletionSecret) {
    throw new Error("删除验证准备已失效")
  }
  assertRpc(
    await getSupabase().rpc("prepare_account_deletion", {
      p_token: flow.deletionSecret,
    }),
    "准备账号删除失败",
  )
  const { error } = await getSupabase().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, captchaToken },
  })
  if (error) throw error
  return { ...flow, sentAt: Date.now() }
}

export function createPreparedAccountDeletionFlow(
  user: User,
): PendingAccountFlow {
  if (user.is_anonymous || !user.email) {
    throw new Error("只有已绑定邮箱的账号可以执行此操作")
  }
  return {
    kind: "delete",
    email: normalizeEmail(user.email),
    sentAt: 0,
    preparedAt: Date.now(),
    deletionSecret: createMergeSecret(),
  }
}

export async function resumePendingAccountFlow(
  flow: PendingAccountFlow,
  user: User | null,
  recovery?: AccountMergeRecovery | null,
  onRecoveryUpdated?: (recovery: AccountMergeRecovery) => void,
) {
  if (flow.kind === "merge") {
    const validRecovery = validateMergeRecovery(flow, recovery)
    const currentIsTarget = isMatchingTargetUser(user, validRecovery)
    if (
      user &&
      !((user.is_anonymous && user.id === flow.sourceUserId) || currentIsTarget)
    ) {
      throw new Error("当前账号与待恢复的记录合并不匹配")
    }
    const mergeSecret = flow.mergeSecret
    if (!mergeSecret) throw new Error("记录合并凭证已丢失，请重新发起")

    if (currentIsTarget) {
      try {
        return await withSupabaseAuthMutationLock(async () => {
          const supabase = getSupabase()
          const { data: live, error: liveError } =
            await supabase.auth.getSession()
          if (liveError) throw liveError
          if (!isMatchingTargetUser(live.session?.user, validRecovery)) {
            throw new Error("当前账号已在其他标签页改变，请重新验证目标邮箱。")
          }
          const { data: verified, error: verificationError } =
            await supabase.auth.getUser()
          if (verificationError) throw verificationError
          if (!isMatchingTargetUser(verified.user, validRecovery)) {
            throw new Error("目标邮箱账号的服务器验证结果不一致。")
          }
          const raw = assertJsonObject(
            assertRpc(
              await supabase.rpc("consume_account_merge", {
                p_token: mergeSecret,
              }),
              "恢复记录合并失败",
            ),
            "合并结果格式异常",
          )
          return {
            user: verified.user as User,
            merge: {
              tasks: asCount(raw.tasks),
              sessions: asCount(raw.sessions),
              behaviorEvents: asCount(raw.behavior_events),
              reminderEvents: asCount(raw.reminder_events),
              reviews: asCount(raw.reviews),
            },
            recoveredWithoutReceipt: false,
          }
        })
      } catch (mergeError) {
        // Being logged into the target only proves mailbox ownership. It does
        // not prove that the source rows were moved. A different live session
        // for the same target cannot read a receipt bound to the original OTP
        // session, so retry that canonical authorization failure below with
        // the isolated recovery session. Unknown responses stay uncertain.
        const code =
          mergeError instanceof Error && "code" in mergeError
            ? String(mergeError.code ?? "")
            : ""
        if (code !== "42501") {
          throw mergeAttemptError(mergeError, "result_uncertain")
        }
      }
    }

    let transient: ReturnType<typeof createTransientSupabase>
    let targetUser: User
    let refreshedRecovery: AccountMergeRecovery
    try {
      const target = await openTransientTargetSession(validRecovery)
      transient = target.transient
      targetUser = target.user
      refreshedRecovery = target.recovery
      onRecoveryUpdated?.(refreshedRecovery)
    } catch (targetError) {
      const sourceState = await inspectMergeSource(flow)
      if (sourceState === "valid") {
        throw mergeAttemptError(targetError, "source_restored")
      }
      if (sourceState === "missing") {
        throw mergeAttemptError(targetError, "target_reverification_required")
      }
      throw mergeAttemptError(targetError, "result_uncertain")
    }

    let raw: JsonObject
    try {
      raw = assertJsonObject(
        assertRpc(
          await transient.rpc("consume_account_merge", {
            p_token: mergeSecret,
          }),
          "恢复记录合并失败",
        ),
        "合并结果格式异常",
      )
    } catch (mergeError) {
      if (isDefinitiveAccountRpcRollback(mergeError)) {
        const sourceState = await inspectMergeSource(flow)
        if (sourceState === "valid") {
          await revokeTransientSessionBestEffort(transient)
          throw mergeAttemptError(mergeError, "source_restored")
        }
        if (sourceState === "missing") {
          try {
            const committedUser = await commitTargetSession(refreshedRecovery)
            return {
              user: committedUser,
              merge: null,
              recoveredWithoutReceipt: true,
            }
          } catch (sessionError) {
            throw mergeAttemptError(
              sessionError,
              "target_reverification_required",
            )
          }
        }
      }
      throw mergeAttemptError(mergeError, "result_uncertain")
    }

    try {
      targetUser = await commitTargetSession(refreshedRecovery)
    } catch (sessionError) {
      throw mergeAttemptError(sessionError, "target_reverification_required")
    }

    return {
      user: targetUser,
      merge: {
        tasks: asCount(raw.tasks),
        sessions: asCount(raw.sessions),
        behaviorEvents: asCount(raw.behavior_events),
        reminderEvents: asCount(raw.reminder_events),
        reviews: asCount(raw.reviews),
      },
      recoveredWithoutReceipt: false,
    }
  }

  if (!user || user.is_anonymous) return null
  if (!user.email || normalizeEmail(user.email) !== flow.email) return null
  if (flow.kind === "upgrade" && user.id !== flow.sourceUserId) {
    return null
  } else if (flow.kind === "delete" || flow.kind === "confirm_merge") {
    return null
  }

  await ensureSettings(user.id)
  await touchMyActivity()
  return { user, merge: null, recoveredWithoutReceipt: false }
}

export async function verifyAndDeleteAccount(
  flow: PendingAccountFlow,
  token: string,
) {
  if (flow.kind !== "delete") throw new Error("账号删除流程已失效")
  if (!flow.deletionSecret) throw new Error("删除验证凭证已丢失")
  const deletionSecret = flow.deletionSecret
  return withSupabaseAuthMutationLock(async () => {
    const supabase = getSupabase()
    const { data, error } = await supabase.auth.verifyOtp({
      email: flow.email,
      token,
      type: "email",
    })
    if (error) throw error
    if (!data.user || data.user.is_anonymous)
      throw new Error("无法验证待删除账号")

    assertRpcSuccess(
      await getSupabase().rpc("delete_my_account", {
        p_token: deletionSecret,
      }),
    )
    await supabase.auth.signOut({ scope: "local" })
  })
}

export async function signOutSafely() {
  return withSupabaseAuthMutationLock(async () => {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from("study_sessions")
      .select("id,status")
      .eq("status", "running")
      .maybeSingle()
    if (error) throw error

    if (data?.status === "running") {
      assertRpc(
        await getSupabase().rpc("pause_study_session_for_navigation", {
          p_session_id: data.id,
        }),
        "暂停当前学习时段失败",
      )
    }

    const { error: signOutError } = await supabase.auth.signOut({
      scope: "local",
    })
    if (signOutError) throw signOutError
  })
}
