import type { Page, Route } from "@playwright/test"

type Row = Record<string, unknown>

const userId = "e2e00000-0000-4000-8000-000000000001"
const permanentUserId = "e2e00000-0000-4000-8000-000000000002"
const now = () => new Date().toISOString()

type MockAccountKind = "anonymous" | "permanent"

type MockSupabaseOptions = {
  seedSession?: boolean
  seedSettings?: boolean
  resumeDelayMs?: number
  accountKind?: MockAccountKind
  accountEmail?: string
  existingAccountEmails?: string[]
  expectedOtp?: string
  gatewayTimeoutAfterMerge?: boolean
  invalidFirstMergeShape?: boolean
  loseFirstMergeResponse?: boolean
  loseFirstPrepareResponse?: boolean
  rejectFirstPrepareDefinitively?: boolean
  failSummaryAfterMerge?: boolean
  rejectFirstMergeForCapacity?: boolean
  timeoutBeforeMergeThenCapacityRollback?: boolean
  mergeResponseDelayMs?: number
  verifyOtpDelayMs?: number
  cancelMergeDelayMs?: number
  seedExpiredMergeRecovery?: {
    email: string
    mergeSecret: string
  }
  seedRunningStudySession?: boolean
  accountSummary?: Partial<{
    tasks: number
    sessions: number
    behaviorEvents: number
    reviews: number
  }>
}

export type MockSupabaseHandle = {
  anonymousUserId: string
  permanentUserId: string
  authEvents: string[]
  currentUser: () => Row | null
  clearPersistentSession: (page: Page) => Promise<void>
  switchPersistentSessionToTarget: (page: Page) => Promise<void>
  studySessions: () => Row[]
}

function encodeJwtPart(value: Row) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function authUser({
  id,
  email = "",
  isAnonymous,
}: {
  id: string
  email?: string
  isAnonymous: boolean
}) {
  const timestamp = now()
  const provider = isAnonymous ? "anonymous" : "email"
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email,
    phone: "",
    app_metadata: { provider, providers: [provider] },
    user_metadata: {},
    identities: isAnonymous
      ? []
      : [
          {
            identity_id: `${id}-email`,
            id,
            user_id: id,
            identity_data: {
              email,
              email_verified: true,
              phone_verified: false,
              sub: id,
            },
            provider: "email",
            email,
            created_at: timestamp,
            updated_at: timestamp,
            last_sign_in_at: timestamp,
          },
        ],
    is_anonymous: isAnonymous,
    created_at: timestamp,
    updated_at: timestamp,
    ...(isAnonymous
      ? {}
      : { email_confirmed_at: timestamp, last_sign_in_at: timestamp }),
  }
}

function fakeAccessToken(
  user: Row,
  sessionId: string,
  expiresInSeconds = 3_600,
) {
  return [
    encodeJwtPart({ alg: "HS256", typ: "JWT" }),
    encodeJwtPart({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1_000) + expiresInSeconds,
      role: "authenticated",
      sub: user.id,
      session_id: sessionId,
      is_anonymous: user.is_anonymous,
      email: user.email,
    }),
    "e2e-signature0",
  ].join(".")
}

function userClaimsFromAuthorization(value: string | undefined) {
  const token = value?.replace(/^Bearer\s+/i, "")
  const payload = token?.split(".")[1]
  if (!payload) return null
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Row
  } catch {
    return null
  }
}

function sessionPayload(
  user: Row = authUser({ id: userId, isAnonymous: true }),
  sessionId = crypto.randomUUID(),
  expiresInSeconds = 3_600,
  refreshToken = `e2e-refresh-${String(user.id)}-${sessionId}`,
) {
  return {
    access_token: fakeAccessToken(user, sessionId, expiresInSeconds),
    token_type: "bearer",
    expires_in: expiresInSeconds,
    expires_at: Math.floor(Date.now() / 1_000) + expiresInSeconds,
    refresh_token: refreshToken,
    user,
  }
}

function settingRow(ownerId = userId): Row {
  const timestamp = now()
  return {
    user_id: ownerId,
    consent_version: "2026-08-v1",
    consented_at: timestamp,
    reminders_enabled: true,
    camera_enabled_default: false,
    privacy_mode: "local_only",
    experiment_mode: false,
    calibration_seconds: 3,
    sample_fps: 4,
    face_absent_seconds: 5,
    direction_hold_seconds: 3,
    neutral_recovery_seconds: 1,
    reminder_delay_seconds: 15,
    reminder_cooldown_seconds: 600,
    yaw_threshold_degrees: 25,
    pitch_threshold_degrees: 20,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

function idFrom(url: URL) {
  return url.searchParams.get("id")?.replace(/^eq\./, "") ?? null
}

function filterRows(rows: Row[], url: URL) {
  const id = idFrom(url)
  let result = id ? rows.filter((row) => row.id === id) : rows
  for (const column of ["task_id", "session_id", "user_id"] as const) {
    const value = url.searchParams.get(column)?.replace(/^eq\./, "")
    if (value) result = result.filter((row) => row[column] === value)
  }
  if (
    url.searchParams.has("status") &&
    url.pathname.endsWith("study_sessions")
  ) {
    const status = url.searchParams.get("status") ?? ""
    if (status.startsWith("in.")) {
      result = result.filter((row) =>
        ["running", "paused"].includes(String(row.status)),
      )
    } else if (status.startsWith("eq.")) {
      const expectedStatus = status.replace(/^eq\./, "")
      result = result.filter((row) => row.status === expectedStatus)
    }
  }
  return result
}

function taskStepsComplete(task: Row | undefined) {
  const steps = Array.isArray(task?.steps) ? task.steps : []
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        Boolean(step) &&
        typeof step === "object" &&
        !Array.isArray(step) &&
        (step as Row).completed === true,
    )
  )
}

async function fulfillJson(route: Route, data: unknown, status = 200) {
  const request = route.request()
  const accept = request.headers().accept ?? ""
  let responseData = data
  if (accept.includes("application/vnd.pgrst.object") && Array.isArray(data)) {
    responseData = data[0] ?? null
  }
  await route.fulfill({
    status,
    body: status === 204 ? "" : JSON.stringify(responseData),
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range",
      "content-range": Array.isArray(data)
        ? `0-${Math.max(0, data.length - 1)}/${data.length}`
        : "0-0/1",
      "content-type": "application/json",
      "x-supabase-api-version": "2024-01-01",
    },
  })
}

export async function installMockSupabase(
  page: Page,
  options: MockSupabaseOptions = {},
): Promise<MockSupabaseHandle> {
  const accountEmail = (options.accountEmail ?? "student@example.com")
    .trim()
    .toLocaleLowerCase("en-US")
  const initialUser =
    options.accountKind === "permanent"
      ? authUser({
          id: permanentUserId,
          email: accountEmail,
          isAnonymous: false,
        })
      : authUser({ id: userId, isAnonymous: true })
  let currentUser: Row | null =
    options.seedSession === false ? null : initialUser
  const users = new Map<string, Row>()
  users.set(String(initialUser.id), initialUser)
  let pendingUpgradeEmail: string | null = null
  let pendingOtpEmail: string | null = null
  let preparedMerge: { token: string; email: string } | null = null
  let consumedMerge: {
    token: string
    targetUserId: string
    targetSessionId: string
    result: Row
  } | null = null
  let preparedDeletionToken: string | null = null
  let mergeResponseLost = false
  let prepareResponseLost = false
  let prepareRejected = false
  let capacityMergeRejected = false
  const authEvents: string[] = []
  const knownAccounts = new Map<string, string>()
  for (const email of options.existingAccountEmails ?? []) {
    const normalized = email.trim().toLocaleLowerCase("en-US")
    knownAccounts.set(normalized, permanentUserId)
    users.set(
      permanentUserId,
      authUser({
        id: permanentUserId,
        email: normalized,
        isAnonymous: false,
      }),
    )
  }
  if (options.accountKind === "permanent") {
    knownAccounts.set(accountEmail, permanentUserId)
    users.set(permanentUserId, initialUser)
  }
  if (options.seedExpiredMergeRecovery) {
    const recoveryEmail = options.seedExpiredMergeRecovery.email
      .trim()
      .toLocaleLowerCase("en-US")
    knownAccounts.set(recoveryEmail, permanentUserId)
    users.set(
      permanentUserId,
      authUser({
        id: permanentUserId,
        email: recoveryEmail,
        isAnonymous: false,
      }),
    )
    preparedMerge = {
      token: options.seedExpiredMergeRecovery.mergeSecret,
      email: recoveryEmail,
    }
  }

  const claimsForRequest = (request: ReturnType<Route["request"]>) =>
    userClaimsFromAuthorization(request.headers()["authorization"])
  const userForRequest = (request: ReturnType<Route["request"]>) => {
    const claims = claimsForRequest(request)
    return claims?.sub ? (users.get(String(claims.sub)) ?? null) : null
  }

  const settings: Row[] =
    options.seedSettings === false || !currentUser
      ? []
      : [settingRow(String(currentUser.id))]
  const tasks: Row[] = []
  const sessions: Row[] = []
  const behaviorEvents: Row[] = []
  const reminders: Row[] = []
  const reviews: Row[] = []

  if (options.seedRunningStudySession && currentUser) {
    const timestamp = now()
    const taskId = "e2e-task-active"
    tasks.push({
      id: taskId,
      user_id: currentUser.id,
      title: "正在进行的学习任务",
      steps: [{ id: "e2e-step-active", title: "继续完成", completed: false }],
      priority: "medium",
      estimated_minutes: 30,
      status: "in_progress",
      completed_at: null,
      observation_profile: "study_screen_v1",
      created_at: timestamp,
      updated_at: timestamp,
    })
    sessions.push({
      id: "e2e-session-active",
      user_id: currentUser.id,
      task_id: taskId,
      status: "running",
      accumulated_seconds: 90,
      started_at: timestamp,
      resumed_at: timestamp,
      ended_at: null,
      camera_enabled: false,
      reminders_enabled: true,
      experiment_mode: false,
      observation_profile: "study_screen_v1",
      task_outcome: null,
      state_version: 0,
      camera_version: 0,
      created_at: timestamp,
      updated_at: timestamp,
    })
  }

  if (currentUser) {
    await page.context().addInitScript(
      ({ markerKey, storageKey, session }) => {
        if (window.localStorage.getItem(markerKey)) return
        window.localStorage.setItem(markerKey, "true")
        window.localStorage.setItem(storageKey, JSON.stringify(session))
      },
      {
        markerKey: "studytrace.e2e-auth-seeded",
        storageKey: "sb-127-auth-token",
        session: sessionPayload(currentUser),
      },
    )
  }

  if (options.seedExpiredMergeRecovery) {
    const recoveryEmail = options.seedExpiredMergeRecovery.email
      .trim()
      .toLocaleLowerCase("en-US")
    const targetUser = users.get(permanentUserId)
    if (!targetUser) throw new Error("Seeded target account is missing")
    const targetSessionId = crypto.randomUUID()
    const expiredTargetSession = sessionPayload(
      targetUser,
      targetSessionId,
      -60,
    )
    await page.context().addInitScript(
      ({ flow, recovery, marker }) => {
        sessionStorage.setItem(
          "studytrace.pending-account-flow.v1",
          JSON.stringify(flow),
        )
        sessionStorage.setItem(
          "studytrace.pending-account-merge-recovery.v1",
          JSON.stringify(recovery),
        )
        localStorage.setItem(
          "studytrace.account-merge-handoff.v1",
          JSON.stringify(marker),
        )
      },
      {
        flow: {
          kind: "merge",
          email: recoveryEmail,
          sentAt: Date.now(),
          sourceUserId: userId,
          mergeSecret: options.seedExpiredMergeRecovery.mergeSecret,
          mergeRecoveryRequired: true,
        },
        recovery: {
          sourceUserId: userId,
          targetUserId: permanentUserId,
          email: recoveryEmail,
          accessToken: expiredTargetSession.access_token,
          refreshToken: expiredTargetSession.refresh_token,
          capturedAt: Date.now(),
        },
        marker: {
          sourceUserId: userId,
          targetUserId: permanentUserId,
          email: recoveryEmail,
          capturedAt: Date.now(),
        },
      },
    )
  }

  await page.context().route("http://127.0.0.1:54321/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (method === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers":
            "authorization,apikey,content-type,prefer,x-client-info,x-supabase-api-version",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        },
      })
      return
    }

    if (url.pathname === "/auth/v1/user" && method === "GET") {
      const claims = userClaimsFromAuthorization(
        request.headers()["authorization"],
      )
      const requestedUser = claims?.sub
        ? (users.get(String(claims.sub)) ?? null)
        : null
      if (!requestedUser) {
        await fulfillJson(
          route,
          {
            code: "user_not_found",
            error_code: "user_not_found",
            message: "User from sub claim in JWT does not exist",
          },
          403,
        )
        return
      }
      await fulfillJson(route, requestedUser)
      return
    }

    if (
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    ) {
      const body = (request.postDataJSON() ?? {}) as Row
      const refreshToken = String(body.refresh_token ?? "")
      const targetEntry = [...users.entries()].find(([id]) =>
        refreshToken.startsWith(`e2e-refresh-${id}-`),
      )
      if (!targetEntry) {
        await fulfillJson(
          route,
          {
            code: "refresh_token_not_found",
            error_code: "refresh_token_not_found",
            message: "Invalid Refresh Token: Refresh Token Not Found",
          },
          400,
        )
        return
      }
      const [targetId, targetUser] = targetEntry
      const sessionId = refreshToken.slice(`e2e-refresh-${targetId}-`.length)
      authEvents.push("refresh-target-session")
      await fulfillJson(
        route,
        sessionPayload(targetUser, sessionId, 3_600, `${refreshToken}-rotated`),
      )
      return
    }

    if (url.pathname === "/auth/v1/signup" && method === "POST") {
      currentUser = authUser({ id: userId, isAnonymous: true })
      users.set(userId, currentUser)
      authEvents.push("anonymous-sign-in")
      await fulfillJson(route, sessionPayload(currentUser))
      return
    }

    if (url.pathname === "/auth/v1/user" && method === "PUT") {
      const body = (request.postDataJSON() ?? {}) as Row
      const email = String(body.email ?? "")
        .trim()
        .toLocaleLowerCase("en-US")
      const existingId = knownAccounts.get(email)
      authEvents.push("request-email-upgrade")
      const actor = userForRequest(request)
      if (!actor) {
        await fulfillJson(
          route,
          {
            code: "session_not_found",
            error_code: "session_not_found",
            message: "Auth session missing",
          },
          401,
        )
        return
      }
      if (existingId && existingId !== actor.id) {
        await fulfillJson(
          route,
          {
            code: "email_exists",
            error_code: "email_exists",
            message:
              "A user with this email address has already been registered",
          },
          422,
        )
        return
      }

      pendingUpgradeEmail = email
      const updatedActor = { ...actor, email, updated_at: now() }
      users.set(String(actor.id), updatedActor)
      currentUser = updatedActor
      await fulfillJson(route, { user: updatedActor })
      return
    }

    if (url.pathname === "/auth/v1/otp" && method === "POST") {
      const body = (request.postDataJSON() ?? {}) as Row
      const email = String(body.email ?? "")
        .trim()
        .toLocaleLowerCase("en-US")
      authEvents.push("send-otp")
      if (body.create_user === false && !knownAccounts.has(email)) {
        await fulfillJson(
          route,
          {
            code: "invalid_credentials",
            error_code: "invalid_credentials",
            message: "Signups not allowed for otp",
          },
          400,
        )
        return
      }
      pendingOtpEmail = email
      await fulfillJson(route, {})
      return
    }

    if (url.pathname === "/auth/v1/resend" && method === "POST") {
      authEvents.push("resend-otp")
      await fulfillJson(route, {})
      return
    }

    if (url.pathname === "/auth/v1/verify" && method === "POST") {
      const body = (request.postDataJSON() ?? {}) as Row
      const email = String(body.email ?? "")
        .trim()
        .toLocaleLowerCase("en-US")
      const token = String(body.token ?? "")
      const verificationType = String(body.type ?? "")
      authEvents.push("verify-otp")
      if (options.verifyOtpDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.verifyOtpDelayMs),
        )
      }
      if (token !== (options.expectedOtp ?? "123456")) {
        await fulfillJson(
          route,
          {
            code: "otp_expired",
            error_code: "otp_expired",
            message: "Token has expired or is invalid",
          },
          403,
        )
        return
      }

      if (verificationType === "email_change") {
        const actor = userForRequest(request) ?? currentUser
        if (!actor || !pendingUpgradeEmail || pendingUpgradeEmail !== email) {
          await fulfillJson(
            route,
            {
              code: "otp_expired",
              error_code: "otp_expired",
              message: "Email change request is no longer valid",
            },
            403,
          )
          return
        }
        const upgradedUser = authUser({
          id: String(actor.id),
          email,
          isAnonymous: false,
        })
        users.set(String(actor.id), upgradedUser)
        currentUser = upgradedUser
        knownAccounts.set(email, String(actor.id))
        pendingUpgradeEmail = null
      } else {
        const targetUserId = knownAccounts.get(email)
        if (!targetUserId || pendingOtpEmail !== email) {
          await fulfillJson(
            route,
            {
              code: "invalid_credentials",
              error_code: "invalid_credentials",
              message: "Email address or OTP is invalid",
            },
            400,
          )
          return
        }
        currentUser =
          users.get(targetUserId) ??
          authUser({ id: targetUserId, email, isAnonymous: false })
        users.set(targetUserId, currentUser)
        pendingOtpEmail = null
      }

      await fulfillJson(route, sessionPayload(currentUser))
      return
    }

    if (url.pathname === "/auth/v1/logout" && method === "POST") {
      authEvents.push("logout")
      currentUser = null
      await fulfillJson(route, null, 204)
      return
    }

    if (url.pathname === "/rest/v1/rpc/touch_my_activity") {
      authEvents.push("touch-activity")
      await fulfillJson(route, now())
      return
    }

    if (url.pathname === "/rest/v1/rpc/get_my_account_transfer_summary") {
      if (options.failSummaryAfterMerge && consumedMerge) {
        await fulfillJson(
          route,
          { code: "XX000", message: "Summary unavailable" },
          500,
        )
        return
      }
      const summary = options.accountSummary ?? {}
      await fulfillJson(route, {
        tasks: summary.tasks ?? tasks.length,
        sessions: summary.sessions ?? sessions.length,
        behavior_events: summary.behaviorEvents ?? behaviorEvents.length,
        reviews: summary.reviews ?? reviews.length,
        has_active_session: sessions.some((session) =>
          ["running", "paused"].includes(String(session.status)),
        ),
      })
      return
    }

    if (url.pathname === "/rest/v1/rpc/prepare_account_merge") {
      const body = (request.postDataJSON() ?? {}) as Row
      const actor = userForRequest(request)
      const requested = {
        token: String(body.p_token ?? ""),
        email: String(body.p_target_email ?? "")
          .trim()
          .toLocaleLowerCase("en-US"),
      }
      if (!actor || actor.id !== userId || actor.is_anonymous !== true) {
        authEvents.push("prepare-merge-source-invalid")
        await fulfillJson(
          route,
          {
            code: "42501",
            message: "Only an anonymous account can prepare a merge",
          },
          403,
        )
        return
      }
      if (options.rejectFirstPrepareDefinitively && !prepareRejected) {
        prepareRejected = true
        authEvents.push("prepare-merge-rollback")
        await fulfillJson(
          route,
          { code: "55000", message: "Prepared merge rejected" },
          409,
        )
        return
      }
      if (
        preparedMerge &&
        (preparedMerge.token !== requested.token ||
          preparedMerge.email !== requested.email)
      ) {
        await fulfillJson(
          route,
          { message: "Another account merge is already in progress" },
          409,
        )
        return
      }
      preparedMerge = {
        token: requested.token,
        email: requested.email,
      }
      authEvents.push("prepare-merge")
      if (options.loseFirstPrepareResponse && !prepareResponseLost) {
        prepareResponseLost = true
        await route.abort("failed")
        return
      }
      await fulfillJson(route, new Date(Date.now() + 10 * 60_000).toISOString())
      return
    }

    if (url.pathname === "/rest/v1/rpc/cancel_account_merge") {
      const body = (request.postDataJSON() ?? {}) as Row
      const token = String(body.p_token ?? "")
      if (options.cancelMergeDelayMs) {
        authEvents.push("cancel-merge-start")
        await new Promise((resolve) =>
          setTimeout(resolve, options.cancelMergeDelayMs),
        )
      }
      const alreadyConsumed = consumedMerge?.token === token
      const actor = userForRequest(request)
      const authorized =
        actor?.id === userId ||
        (actor?.is_anonymous === false && actor.email === preparedMerge?.email)
      const cancelled =
        !alreadyConsumed &&
        (!preparedMerge ||
          (preparedMerge.token === token && Boolean(authorized)))
      if (cancelled) preparedMerge = null
      authEvents.push(cancelled ? "cancel-merge" : "cancel-merge-miss")
      await fulfillJson(route, cancelled)
      return
    }

    if (url.pathname === "/rest/v1/rpc/refresh_account_merge") {
      authEvents.push("refresh-merge")
      await fulfillJson(route, new Date(Date.now() + 10 * 60_000).toISOString())
      return
    }

    if (url.pathname === "/rest/v1/rpc/consume_account_merge") {
      const body = (request.postDataJSON() ?? {}) as Row
      const receipt = consumedMerge
      const claims = claimsForRequest(request)
      const actor = userForRequest(request)
      if (
        receipt &&
        receipt.token === body.p_token &&
        actor?.id === receipt.targetUserId &&
        claims?.session_id === receipt.targetSessionId
      ) {
        authEvents.push("recover-merge-receipt")
        await fulfillJson(route, receipt.result)
        return
      }
      if (
        !preparedMerge ||
        preparedMerge.token !== body.p_token ||
        !actor ||
        actor.is_anonymous === true ||
        actor.email !== preparedMerge.email
      ) {
        await fulfillJson(
          route,
          { message: "Account merge request is invalid or expired" },
          403,
        )
        return
      }
      if (
        options.timeoutBeforeMergeThenCapacityRollback &&
        !mergeResponseLost
      ) {
        mergeResponseLost = true
        await fulfillJson(route, { message: "Gateway timeout" }, 504)
        return
      }
      if (options.rejectFirstMergeForCapacity && !capacityMergeRejected) {
        capacityMergeRejected = true
        await fulfillJson(
          route,
          {
            code: "54000",
            message: "Account merge would exceed the data limit for tasks",
          },
          500,
        )
        return
      }
      const result = {
        tasks: options.accountSummary?.tasks ?? tasks.length,
        sessions: options.accountSummary?.sessions ?? sessions.length,
        behavior_events:
          options.accountSummary?.behaviorEvents ?? behaviorEvents.length,
        reminder_events: reminders.length,
        reviews: options.accountSummary?.reviews ?? reviews.length,
      }
      for (const rows of [
        tasks,
        sessions,
        behaviorEvents,
        reminders,
        reviews,
      ]) {
        rows.forEach((row) => {
          if (row.user_id === userId) row.user_id = actor.id
        })
      }
      consumedMerge = {
        token: preparedMerge.token,
        targetUserId: String(actor.id),
        targetSessionId: String(claims?.session_id ?? ""),
        result,
      }
      preparedMerge = null
      users.delete(userId)
      currentUser = actor
      authEvents.push("consume-merge")
      if (options.mergeResponseDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.mergeResponseDelayMs),
        )
      }
      if (options.loseFirstMergeResponse && !mergeResponseLost) {
        mergeResponseLost = true
        await route.abort("failed")
        return
      }
      if (options.gatewayTimeoutAfterMerge && !mergeResponseLost) {
        mergeResponseLost = true
        await fulfillJson(route, { message: "Gateway timeout" }, 504)
        return
      }
      if (options.invalidFirstMergeShape && !mergeResponseLost) {
        mergeResponseLost = true
        await fulfillJson(route, [])
        return
      }
      await fulfillJson(route, result)
      return
    }

    if (url.pathname === "/rest/v1/rpc/prepare_account_deletion") {
      const body = (request.postDataJSON() ?? {}) as Row
      const requestedToken = String(body.p_token ?? "")
      if (preparedDeletionToken && preparedDeletionToken !== requestedToken) {
        await fulfillJson(
          route,
          {
            message: "Another account deletion verification is in progress",
          },
          409,
        )
        return
      }
      preparedDeletionToken = requestedToken
      authEvents.push("prepare-deletion")
      await fulfillJson(route, new Date(Date.now() + 10 * 60_000).toISOString())
      return
    }

    if (url.pathname === "/rest/v1/rpc/refresh_account_deletion") {
      authEvents.push("refresh-deletion")
      await fulfillJson(route, new Date(Date.now() + 10 * 60_000).toISOString())
      return
    }

    if (url.pathname === "/rest/v1/rpc/cancel_account_deletion") {
      const body = (request.postDataJSON() ?? {}) as Row
      const actor = userForRequest(request)
      const cancelled =
        !preparedDeletionToken ||
        (preparedDeletionToken === String(body.p_token ?? "") &&
          actor?.is_anonymous === false)
      if (cancelled) preparedDeletionToken = null
      authEvents.push(cancelled ? "cancel-deletion" : "cancel-deletion-miss")
      await fulfillJson(route, cancelled)
      return
    }

    if (url.pathname === "/rest/v1/rpc/delete_my_account") {
      const actor = userForRequest(request)
      if (!actor || actor.is_anonymous) {
        await fulfillJson(
          route,
          {
            code: "42501",
            message: "A verified permanent account is required",
          },
          403,
        )
        return
      }
      users.delete(String(actor.id))
      currentUser = null
      preparedDeletionToken = null
      tasks.length = 0
      sessions.length = 0
      behaviorEvents.length = 0
      reminders.length = 0
      reviews.length = 0
      settings.length = 0
      authEvents.push("delete-account")
      await fulfillJson(route, null)
      return
    }

    if (url.pathname === "/rest/v1/rpc/delete_my_data") {
      tasks.length = 0
      sessions.length = 0
      behaviorEvents.length = 0
      reminders.length = 0
      reviews.length = 0
      settings.length = 0
      await fulfillJson(route, null)
      return
    }

    if (url.pathname === "/rest/v1/rpc/start_study_session") {
      const body = (request.postDataJSON() ?? {}) as Row
      const task = tasks.find((row) => row.id === body.p_task_id)
      if (!task || !["planned", "in_progress"].includes(String(task.status))) {
        await fulfillJson(
          route,
          {
            message:
              "Completed or archived tasks cannot start a new study session",
          },
          400,
        )
        return
      }
      if (taskStepsComplete(task)) {
        await fulfillJson(
          route,
          {
            message:
              "Task steps are complete; confirm the task instead of starting another study session",
          },
          400,
        )
        return
      }

      const existing = sessions.find((row) =>
        ["running", "paused"].includes(String(row.status)),
      )
      if (existing) {
        await fulfillJson(route, existing)
        return
      }

      const timestamp = now()
      const session: Row = {
        id: crypto.randomUUID(),
        user_id: userId,
        task_id: task.id,
        status: "running",
        accumulated_seconds: 0,
        started_at: timestamp,
        resumed_at: timestamp,
        ended_at: null,
        camera_enabled: false,
        reminders_enabled: body.p_reminders_enabled ?? true,
        experiment_mode: body.p_experiment_mode ?? false,
        observation_profile: task.observation_profile ?? "study_screen_v1",
        task_outcome: null,
        state_version: 0,
        camera_version: 0,
        created_at: timestamp,
        updated_at: timestamp,
      }
      Object.assign(task, {
        status: "in_progress",
        completed_at: null,
        updated_at: timestamp,
      })
      sessions.push(session)
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/checkpoint_running_session") {
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session) {
        await fulfillJson(route, { message: "Study session not found" }, 404)
        return
      }

      if (
        session.status === "running" &&
        session.resumed_at === body.p_expected_resumed_at &&
        Number(body.p_accumulated_seconds) >=
          Number(session.accumulated_seconds) &&
        new Date(String(body.p_checkpointed_at)).getTime() >=
          new Date(String(session.resumed_at)).getTime()
      ) {
        Object.assign(session, {
          accumulated_seconds: body.p_accumulated_seconds,
          resumed_at: body.p_checkpointed_at,
          updated_at: now(),
        })
      }

      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/pause_study_session") {
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session) {
        await fulfillJson(route, { message: "Study session not found" }, 404)
        return
      }
      if (
        session.status === "running" &&
        Number(session.state_version) === Number(body.p_expected_state_version)
      ) {
        Object.assign(session, {
          status: "paused",
          accumulated_seconds: Math.max(
            Number(session.accumulated_seconds),
            Number(body.p_accumulated_seconds),
          ),
          resumed_at: null,
          camera_enabled: false,
          state_version: Number(session.state_version) + 1,
          updated_at: now(),
        })
      }
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/pause_study_session_for_navigation") {
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session) {
        await fulfillJson(route, { message: "Study session not found" }, 404)
        return
      }
      if (["running", "paused"].includes(String(session.status))) {
        const resumedAt = session.resumed_at
          ? new Date(String(session.resumed_at)).getTime()
          : null
        const runningSeconds =
          session.status === "running" && resumedAt !== null
            ? Math.max(0, Math.floor((Date.now() - resumedAt) / 1_000))
            : 0
        Object.assign(session, {
          status: "paused",
          accumulated_seconds:
            Number(session.accumulated_seconds) + runningSeconds,
          resumed_at: null,
          camera_enabled: false,
          state_version: Number(session.state_version) + 1,
          updated_at: now(),
        })
      }
      authEvents.push("pause-active-session")
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/resume_study_session") {
      if (options.resumeDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.resumeDelayMs),
        )
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session) {
        await fulfillJson(route, { message: "Study session not found" }, 404)
        return
      }
      if (
        session.status === "paused" &&
        Number(session.state_version) === Number(body.p_expected_state_version)
      ) {
        Object.assign(session, {
          status: "running",
          resumed_at: now(),
          camera_enabled: false,
          state_version: Number(session.state_version) + 1,
          updated_at: now(),
        })
      }
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/set_study_session_camera") {
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session) {
        await fulfillJson(route, { message: "Study session not found" }, 404)
        return
      }
      if (
        Number(session.state_version) ===
          Number(body.p_expected_state_version) &&
        Number(body.p_camera_version) > Number(session.camera_version) &&
        (body.p_enabled !== true || session.status === "running")
      ) {
        Object.assign(session, {
          camera_enabled: session.status === "running" ? body.p_enabled : false,
          camera_version: body.p_camera_version,
          updated_at: now(),
        })
      }
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/finish_study_session") {
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session || !["running", "paused"].includes(String(session.status))) {
        await fulfillJson(
          route,
          { message: "Study session has already ended" },
          400,
        )
        return
      }
      const task = tasks.find((row) => row.id === session.task_id)
      const taskSteps = Array.isArray(task?.steps) ? task.steps : []
      const taskComplete =
        taskSteps.length > 0 &&
        taskSteps.every(
          (step) =>
            Boolean(step) &&
            typeof step === "object" &&
            !Array.isArray(step) &&
            (step as Row).completed === true,
        )
      if (body.p_task_outcome !== "completed" || !taskComplete) {
        await fulfillJson(
          route,
          {
            message: "Complete every task step before finishing and reviewing",
          },
          400,
        )
        return
      }
      const timestamp = now()
      Object.assign(session, {
        status: "completed",
        accumulated_seconds: body.p_accumulated_seconds,
        ended_at: timestamp,
        resumed_at: null,
        camera_enabled: false,
        task_outcome: body.p_task_outcome,
        state_version: Number(session.state_version) + 1,
        updated_at: timestamp,
      })
      if (task) {
        Object.assign(task, {
          status: "completed",
          completed_at: timestamp,
          updated_at: timestamp,
        })
      }
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/confirm_task_completion") {
      const body = (request.postDataJSON() ?? {}) as Row
      const task = tasks.find((row) => row.id === body.p_task_id)
      if (!task) {
        await fulfillJson(route, { message: "Task not found" }, 404)
        return
      }
      if (task.status === "completed") {
        await fulfillJson(route, task)
        return
      }
      if (task.status === "archived" || !taskStepsComplete(task)) {
        await fulfillJson(
          route,
          { message: "Complete every task step before confirming the task" },
          400,
        )
        return
      }

      const timestamp = now()
      const session = sessions.find(
        (row) =>
          row.task_id === task.id &&
          ["running", "paused"].includes(String(row.status)),
      )
      if (session) {
        const storedSeconds = Number(session.accumulated_seconds)
        const resumedAt =
          typeof session.resumed_at === "string"
            ? Date.parse(session.resumed_at)
            : Number.NaN
        const serverElapsedSeconds =
          session.status === "running" && Number.isFinite(resumedAt)
            ? Math.max(
                0,
                Math.floor((Date.parse(timestamp) - resumedAt) / 1000),
              )
            : 0
        Object.assign(session, {
          status: "completed",
          accumulated_seconds: Math.max(
            storedSeconds,
            storedSeconds + serverElapsedSeconds,
            Number(body.p_accumulated_seconds ?? 0),
          ),
          ended_at: timestamp,
          resumed_at: null,
          camera_enabled: false,
          task_outcome: "completed",
          state_version: Number(session.state_version) + 1,
          updated_at: timestamp,
        })
        behaviorEvents
          .filter((event) => event.session_id === session.id && !event.ended_at)
          .forEach((event) => Object.assign(event, { ended_at: timestamp }))
      }
      Object.assign(task, {
        status: "completed",
        completed_at: timestamp,
        updated_at: timestamp,
      })
      await fulfillJson(route, task)
      return
    }

    if (url.pathname === "/rest/v1/rpc/reopen_completed_task") {
      const body = (request.postDataJSON() ?? {}) as Row
      const task = tasks.find((row) => row.id === body.p_task_id)
      if (!task || task.status !== "completed") {
        await fulfillJson(
          route,
          { message: "Only completed tasks can be reopened" },
          400,
        )
        return
      }
      const steps = Array.isArray(task.steps) ? task.steps : []
      task.steps = steps.map((step, index) =>
        index === steps.length - 1
          ? { ...(step as Row), completed: false }
          : step,
      )
      Object.assign(task, {
        status: "in_progress",
        completed_at: null,
        updated_at: now(),
      })
      await fulfillJson(route, task)
      return
    }

    if (url.pathname === "/rest/v1/rpc/cancel_study_session") {
      const body = (request.postDataJSON() ?? {}) as Row
      const session = sessions.find((row) => row.id === body.p_session_id)
      if (!session || !["running", "paused"].includes(String(session.status))) {
        await fulfillJson(
          route,
          { message: "Study session has already ended" },
          400,
        )
        return
      }
      const task = tasks.find((row) => row.id === session.task_id)
      const taskSteps = Array.isArray(task?.steps) ? task.steps : []
      const hasCompletedStep = taskSteps.some(
        (step) =>
          Boolean(step) &&
          typeof step === "object" &&
          !Array.isArray(step) &&
          (step as Row).completed === true,
      )
      const timestamp = now()
      Object.assign(session, {
        status: "cancelled",
        accumulated_seconds: body.p_accumulated_seconds,
        ended_at: timestamp,
        resumed_at: null,
        camera_enabled: false,
        task_outcome: hasCompletedStep
          ? "partially_completed"
          : "not_completed",
        state_version: Number(session.state_version) + 1,
        updated_at: timestamp,
      })
      await fulfillJson(route, session)
      return
    }

    if (url.pathname === "/rest/v1/rpc/set_task_step_completed") {
      const body = (request.postDataJSON() ?? {}) as Row
      const task = tasks.find((row) => row.id === body.p_task_id)
      if (!task || ["completed", "archived"].includes(String(task.status))) {
        await fulfillJson(route, { message: "Task not found" }, 404)
        return
      }

      const taskSteps = Array.isArray(task.steps) ? task.steps : []
      const matchingSteps = taskSteps.filter(
        (step) =>
          Boolean(step) &&
          typeof step === "object" &&
          !Array.isArray(step) &&
          (step as Row).id === body.p_step_id,
      )
      if (matchingSteps.length !== 1) {
        await fulfillJson(
          route,
          { message: "Task step not found or duplicated" },
          404,
        )
        return
      }

      task.steps = taskSteps.map((step) =>
        step === matchingSteps[0]
          ? { ...(step as Row), completed: body.p_completed === true }
          : step,
      )
      task.updated_at = now()
      await fulfillJson(route, task)
      return
    }

    const table = url.pathname.replace("/rest/v1/", "")
    const tables: Record<string, Row[]> = {
      tasks,
      study_sessions: sessions,
      behavior_events: behaviorEvents,
      reminder_events: reminders,
      reviews,
      user_settings: settings,
    }
    const rows = tables[table]
    if (!rows) {
      await fulfillJson(route, { message: `Unknown E2E table: ${table}` }, 404)
      return
    }

    if (method === "GET" || method === "HEAD") {
      await fulfillJson(route, filterRows(rows, url))
      return
    }

    if (table === "study_sessions") {
      await fulfillJson(
        route,
        { message: "permission denied for table study_sessions" },
        403,
      )
      return
    }

    const body = (request.postDataJSON() ?? {}) as Row

    if (method === "POST") {
      const existingReview =
        table === "reviews"
          ? rows.find((row) => row.session_id === body.session_id)
          : undefined
      if (existingReview) {
        Object.assign(existingReview, body, { updated_at: now() })
        await fulfillJson(route, [existingReview])
        return
      }

      const timestamp = now()
      const row: Row = {
        id: crypto.randomUUID(),
        created_at: timestamp,
        updated_at: timestamp,
        ...body,
      }
      if (table === "tasks") {
        Object.assign(row, {
          status: "planned",
          completed_at: null,
          observation_profile: body.observation_profile ?? "study_screen_v1",
        })
      }
      if (table === "study_sessions") {
        Object.assign(row, {
          accumulated_seconds: 0,
          started_at: timestamp,
          ended_at: null,
          camera_enabled: false,
          observation_profile: body.observation_profile ?? "study_screen_v1",
          task_outcome: null,
          state_version: body.state_version ?? 0,
          camera_version: body.camera_version ?? 0,
        })
      }
      if (table === "behavior_events") {
        Object.assign(row, {
          review_status: "pending",
          corrected_type: null,
          corrected_direction: null,
          correction_note: null,
        })
      }
      rows.push(row)
      await fulfillJson(route, [row])
      return
    }

    if (method === "PATCH") {
      const matches = filterRows(rows, url)
      if (
        table === "study_sessions" &&
        matches.some((row) =>
          ["completed", "cancelled"].includes(String(row.status)),
        )
      ) {
        await fulfillJson(
          route,
          {
            message: "A completed or cancelled study session cannot be changed",
          },
          400,
        )
        return
      }
      if (
        table === "tasks" &&
        typeof body.observation_profile === "string" &&
        matches.some((task) =>
          sessions.some(
            (session) =>
              session.task_id === task.id &&
              ["running", "paused"].includes(String(session.status)) &&
              task.observation_profile !== body.observation_profile,
          ),
        )
      ) {
        await fulfillJson(
          route,
          {
            message:
              "End the active study session before changing its observation profile",
          },
          400,
        )
        return
      }
      matches.forEach((row) => Object.assign(row, body, { updated_at: now() }))
      const wantsRepresentation =
        (request.headers().prefer ?? "").includes("return=representation") ||
        url.searchParams.has("select")
      await fulfillJson(route, wantsRepresentation ? matches : null)
      return
    }

    if (method === "DELETE") {
      const matches = new Set(filterRows(rows, url))
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches.has(rows[index])) rows.splice(index, 1)
      }
      await fulfillJson(route, null, 204)
      return
    }

    await fulfillJson(
      route,
      { message: `Unhandled E2E method: ${method}` },
      405,
    )
  })

  return {
    anonymousUserId: userId,
    permanentUserId,
    authEvents,
    currentUser: () => currentUser,
    clearPersistentSession: async (targetPage) => {
      currentUser = null
      await targetPage.evaluate((storageKey) => {
        localStorage.removeItem(storageKey)
      }, "sb-127-auth-token")
    },
    switchPersistentSessionToTarget: async (targetPage) => {
      const target = users.get(permanentUserId)
      if (!target) throw new Error("Mock target account is missing")
      currentUser = target
      await targetPage.evaluate(
        ({ storageKey, session }) => {
          localStorage.setItem(storageKey, JSON.stringify(session))
        },
        {
          storageKey: "sb-127-auth-token",
          session: sessionPayload(target),
        },
      )
    },
    studySessions: () => sessions,
  }
}
