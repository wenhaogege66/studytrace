import type { Page, Route } from "@playwright/test"

type Row = Record<string, unknown>

const userId = "e2e00000-0000-4000-8000-000000000001"
const now = () => new Date().toISOString()

function encodeJwtPart(value: Row) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function fakeAccessToken() {
  return [
    encodeJwtPart({ alg: "HS256", typ: "JWT" }),
    encodeJwtPart({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      role: "authenticated",
      sub: userId,
      is_anonymous: true,
    }),
    "e2e-signature",
  ].join(".")
}

function sessionPayload() {
  const createdAt = now()
  return {
    access_token: fakeAccessToken(),
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    refresh_token: "e2e-refresh-token",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "",
      phone: "",
      app_metadata: { provider: "anonymous", providers: ["anonymous"] },
      user_metadata: {},
      identities: [],
      is_anonymous: true,
      created_at: createdAt,
      updated_at: createdAt,
    },
  }
}

function settingRow(): Row {
  const timestamp = now()
  return {
    user_id: userId,
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
  const taskId = url.searchParams.get("task_id")?.replace(/^eq\./, "")
  const sessionId = url.searchParams.get("session_id")?.replace(/^eq\./, "")
  if (taskId) result = result.filter((row) => row.task_id === taskId)
  if (sessionId) result = result.filter((row) => row.session_id === sessionId)
  if (
    url.searchParams.has("status") &&
    url.pathname.endsWith("study_sessions")
  ) {
    const status = url.searchParams.get("status") ?? ""
    if (status.startsWith("in.")) {
      result = result.filter((row) =>
        ["running", "paused"].includes(String(row.status)),
      )
    }
  }
  return result
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
    },
  })
}

export async function installMockSupabase(
  page: Page,
  options: { seedSession?: boolean; seedSettings?: boolean } = {},
) {
  const settings: Row[] = options.seedSettings === false ? [] : [settingRow()]
  const tasks: Row[] = []
  const sessions: Row[] = []
  const behaviorEvents: Row[] = []
  const reminders: Row[] = []
  const reviews: Row[] = []

  if (options.seedSession !== false) {
    await page.addInitScript(
      ({ storageKey, session }) => {
        window.localStorage.setItem(storageKey, JSON.stringify(session))
      },
      { storageKey: "sb-127-auth-token", session: sessionPayload() },
    )
  }

  await page.route("http://127.0.0.1:54321/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (method === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers":
            "authorization,apikey,content-type,prefer,x-client-info",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        },
      })
      return
    }

    if (url.pathname === "/auth/v1/user") {
      await fulfillJson(route, sessionPayload().user)
      return
    }

    if (url.pathname === "/auth/v1/signup" && method === "POST") {
      await fulfillJson(route, sessionPayload())
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
      const existing = sessions.find((row) =>
        ["running", "paused"].includes(String(row.status)),
      )
      if (existing) {
        await fulfillJson(route, existing)
        return
      }

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
        ["running", "paused"].includes(String(session.status)) &&
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

    if (url.pathname === "/rest/v1/rpc/resume_study_session") {
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
      if (task) {
        Object.assign(task, {
          status: "in_progress",
          completed_at: null,
          updated_at: timestamp,
        })
      }
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
}
