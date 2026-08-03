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
  options: { seedSession?: boolean } = {},
) {
  const settings: Row[] = [settingRow()]
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
        Object.assign(row, { status: "planned", completed_at: null })
      }
      if (table === "study_sessions") {
        Object.assign(row, {
          accumulated_seconds: 0,
          started_at: timestamp,
          ended_at: null,
          camera_enabled: false,
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
