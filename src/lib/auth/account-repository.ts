import type { User } from "@supabase/supabase-js"

import {
  createMergeSecret,
  isExistingEmailError,
  normalizeEmail,
  type AccountMergeResult,
  type AccountTransferSummary,
  type PendingAccountFlow,
} from "@/lib/auth/account"
import { ensureSettings } from "@/lib/data/study-repository"
import { getSupabase } from "@/lib/supabase/client"

type DataError = { code?: string; message: string }
type RpcResponse<T> = Promise<{ data: T | null; error: DataError | null }>
type AuthRpcClient = {
  rpc: (name: string, args?: Record<string, unknown>) => RpcResponse<unknown>
}

function authRpc<T>(name: string, args?: Record<string, unknown>) {
  return (getSupabase() as unknown as AuthRpcClient).rpc(
    name,
    args,
  ) as RpcResponse<T>
}

function assertRpc<T>(
  response: { data: T | null; error: DataError | null },
  fallback: string,
) {
  if (response.error)
    throw Object.assign(new Error(response.error.message), response.error)
  if (response.data === null) throw new Error(fallback)
  return response.data
}

function assertRpcSuccess(response: {
  data: unknown
  error: DataError | null
}) {
  if (response.error)
    throw Object.assign(new Error(response.error.message), response.error)
}

function asCount(value: unknown) {
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0
}

export async function touchMyActivity() {
  const response = await authRpc<string>("touch_my_activity")
  return assertRpc(response, "更新活动时间失败")
}

export async function getAccountTransferSummary(): Promise<AccountTransferSummary> {
  const raw = assertRpc(
    await authRpc<Record<string, unknown>>("get_my_account_transfer_summary"),
    "读取待同步记录失败",
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
}

export async function confirmAccountMerge(
  flow: PendingAccountFlow,
  captchaToken?: string,
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
    await authRpc<string>("prepare_account_merge", {
      p_token: flow.mergeSecret,
      p_target_email: flow.email,
    }),
    "准备记录合并失败",
  )

  const { error: otpError } = await supabase.auth.signInWithOtp({
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
    assertRpc(
      await authRpc<string>("refresh_account_merge", {
        p_token: flow.mergeSecret,
      }),
      "刷新记录合并请求失败",
    )
  } else if (flow.kind === "delete") {
    if (!flow.deletionSecret) throw new Error("删除验证凭证已丢失")
    assertRpc(
      await authRpc<string>("refresh_account_deletion", {
        p_token: flow.deletionSecret,
      }),
      "刷新删除验证请求失败",
    )
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: flow.email,
    options: { shouldCreateUser: false, captchaToken },
  })
  if (error) throw error
  return { ...flow, sentAt: Date.now() }
}

export async function verifyAccountOtp(
  flow: PendingAccountFlow,
  token: string,
) {
  if (flow.kind === "confirm_merge") {
    throw new Error("请先确认并发送验证码")
  }
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

  let merge: AccountMergeResult | null = null
  if (flow.kind === "merge") {
    if (!flow.mergeSecret || data.user.is_anonymous) {
      throw new Error("无法确认记录合并身份")
    }
    const raw = assertRpc(
      await authRpc<Record<string, unknown>>("consume_account_merge", {
        p_token: flow.mergeSecret,
      }),
      "合并匿名记录失败",
    )
    merge = {
      tasks: asCount(raw.tasks),
      sessions: asCount(raw.sessions),
      behaviorEvents: asCount(raw.behavior_events),
      reminderEvents: asCount(raw.reminder_events),
      reviews: asCount(raw.reviews),
    }
  }

  if (flow.kind !== "delete") await ensureSettings(data.user.id)
  await touchMyActivity()
  return { user: data.user, merge }
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
    await authRpc<string>("prepare_account_deletion", {
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
  user: User,
) {
  if (user.is_anonymous) return null
  if (!user.email || normalizeEmail(user.email) !== flow.email) return null

  let merge: AccountMergeResult | null = null
  if (flow.kind === "merge") {
    if (!flow.mergeSecret) throw new Error("记录合并凭证已丢失，请重新发起")
    const raw = assertRpc(
      await authRpc<Record<string, unknown>>("consume_account_merge", {
        p_token: flow.mergeSecret,
      }),
      "恢复记录合并失败",
    )
    merge = {
      tasks: asCount(raw.tasks),
      sessions: asCount(raw.sessions),
      behaviorEvents: asCount(raw.behavior_events),
      reminderEvents: asCount(raw.reminder_events),
      reviews: asCount(raw.reviews),
    }
  } else if (flow.kind === "upgrade" && user.id !== flow.sourceUserId) {
    return null
  } else if (flow.kind === "delete" || flow.kind === "confirm_merge") {
    return null
  }

  await ensureSettings(user.id)
  await touchMyActivity()
  return { user, merge }
}

export async function verifyAndDeleteAccount(
  flow: PendingAccountFlow,
  token: string,
) {
  if (flow.kind !== "delete") throw new Error("账号删除流程已失效")
  if (!flow.deletionSecret) throw new Error("删除验证凭证已丢失")
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
    await authRpc<undefined>("delete_my_account", {
      p_token: flow.deletionSecret,
    }),
  )
  await supabase.auth.signOut({ scope: "local" })
}

export async function signOutSafely() {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from("study_sessions")
    .select("id,status")
    .eq("status", "running")
    .maybeSingle()
  if (error) throw error

  if (data?.status === "running") {
    assertRpc(
      await authRpc<unknown>("pause_study_session_for_navigation", {
        p_session_id: data.id,
      }),
      "暂停当前学习时段失败",
    )
  }

  const { error: signOutError } = await supabase.auth.signOut({
    scope: "local",
  })
  if (signOutError) throw signOutError
}
