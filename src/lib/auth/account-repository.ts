import { normalizeEmail, validatePassword } from "@/lib/auth/account"
import {
  createTransientSupabase,
  getSupabase,
  withSupabaseAuthMutationLock,
} from "@/lib/supabase/client"

export const IDENTITY_CHANGING_EVENT = "studytrace:identity-changing"

function stopObservation() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(IDENTITY_CHANGING_EVENT))
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("studytrace:identity")
    channel.postMessage("changing")
    channel.close()
  }
}

async function pauseRunningSession() {
  const supabase = getSupabase()
  const { data: active, error } = await supabase
    .from("study_sessions")
    .select("id,status")
    .eq("status", "running")
    .maybeSingle()
  if (error) throw error
  if (active) {
    const { error: pauseError } = await supabase.rpc(
      "pause_study_session_for_navigation",
      { p_session_id: active.id },
    )
    if (pauseError) throw pauseError
  }
}

async function cleanupTransient(
  client: ReturnType<typeof createTransientSupabase>,
) {
  try {
    await client.auth.signOut({ scope: "local" })
  } catch {
    // Best-effort revocation of an uncommitted session; main storage is untouched.
  }
}

export async function authenticatePasswordAccount({
  mode,
  email: rawEmail,
  password: rawPassword,
  captchaToken,
}: {
  mode: "sign_in" | "sign_up"
  email: string
  password: string
  captchaToken?: string
}) {
  const email = normalizeEmail(rawEmail)
  const password = validatePassword(rawPassword)
  const main = getSupabase()
  const { data: source, error: sourceError } = await main.auth.getSession()
  if (sourceError) throw sourceError
  const sourceId = source.session?.user.id ?? null
  const transient = createTransientSupabase()
  let committed = false
  try {
    const credentials = { email, password, options: { captchaToken } }
    const result =
      mode === "sign_up"
        ? await transient.auth.signUp(credentials)
        : await transient.auth.signInWithPassword(credentials)
    if (result.error) throw result.error
    const session = result.data.session
    if (!session)
      throw new Error(
        "当前环境仍要求邮箱确认，请联系维护者关闭邮箱确认后重试。",
      )
    const { data: verified, error: verifyError } =
      await transient.auth.getUser()
    if (verifyError) throw verifyError
    const user = verified.user
    if (
      !user ||
      user.is_anonymous ||
      !user.email ||
      normalizeEmail(user.email) !== email
    ) {
      throw new Error("账号身份与本次验证不一致，请重试。")
    }
    await withSupabaseAuthMutationLock(async () => {
      const { data: current, error } = await main.auth.getSession()
      if (error) throw error
      if ((current.session?.user.id ?? null) !== sourceId)
        throw new Error("其他页面已切换身份，请刷新后再试。")
      stopObservation()
      if (sourceId) await pauseRunningSession()
      const { error: handoffError } = await main.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      })
      if (handoffError) {
        // Failed credentials never get here; restore the source if handoff fails.
        if (source.session) {
          const { error: restoreError } = await main.auth.setSession({
            access_token: source.session.access_token,
            refresh_token: source.session.refresh_token,
          })
          if (restoreError)
            throw new Error("身份切换未完成，请刷新核对当前身份后重试。", {
              cause: restoreError,
            })
        } else await main.auth.signOut({ scope: "local" })
        throw handoffError
      }
      committed = true
    })
    return user
  } finally {
    // Successful handoff shares its Auth session ID: do not revoke that session.
    if (!committed) await cleanupTransient(transient)
  }
}

export async function touchMyActivity() {
  const { error } = await getSupabase().rpc("touch_my_activity")
  if (error) throw error
}

export async function signOutSafely() {
  return withSupabaseAuthMutationLock(async () => {
    stopObservation()
    await pauseRunningSession()
    const { error } = await getSupabase().auth.signOut({ scope: "local" })
    if (error) throw error
  })
}

export async function deletePasswordAccount(
  password: string,
  captchaToken?: string,
) {
  validatePassword(password)
  const main = getSupabase()
  const { data: source, error } = await main.auth.getSession()
  if (error) throw error
  const sourceUser = source.session?.user
  if (!sourceUser?.email || sourceUser.is_anonymous)
    throw new Error("请先登录邮箱账号。")
  const transient = createTransientSupabase()
  let deleted = false
  try {
    const { data: fresh, error: passwordError } =
      await transient.auth.signInWithPassword({
        email: sourceUser.email,
        password,
        options: { captchaToken },
      })
    if (passwordError) throw passwordError
    const { data: verified, error: verificationError } =
      await transient.auth.getUser()
    if (verificationError) throw verificationError
    if (
      !fresh.session ||
      verified.user?.id !== sourceUser.id ||
      verified.user.is_anonymous
    )
      throw new Error("账号身份与本次验证不一致，请重试。")
    await withSupabaseAuthMutationLock(async () => {
      const { data: current, error: currentError } =
        await main.auth.getSession()
      if (currentError) throw currentError
      if (current.session?.user.id !== sourceUser.id)
        throw new Error("其他页面已切换身份，请刷新后再试。")
      stopObservation()
      await pauseRunningSession()
      // No password is sent to SQL: this token proves a fresh password sign-in.
      const { error: deletionError } = await transient.rpc(
        "delete_my_password_account",
      )
      if (deletionError) throw deletionError
      deleted = true
      await main.auth.signOut({ scope: "local" })
    })
  } finally {
    if (!deleted) await cleanupTransient(transient)
  }
}
