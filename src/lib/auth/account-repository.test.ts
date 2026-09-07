import type { User } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ensureSettings: vi.fn(),
  getSession: vi.fn(),
  updateUser: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}))

vi.mock("@/lib/data/study-repository", () => ({
  ensureSettings: mocks.ensureSettings,
}))

vi.mock("@/lib/supabase/client", () => ({
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
      updateUser: mocks.updateUser,
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
      resend: mocks.resend,
      signOut: mocks.signOut,
    },
    rpc: mocks.rpc,
    from: () => ({ select: mocks.select }),
  }),
}))

import {
  beginEmailAccountFlow,
  confirmAccountMerge,
  createPreparedAccountDeletionFlow,
  createPreparedAccountMergeFlow,
  requestAccountDeletionOtp,
  resendAccountOtp,
  resumePendingAccountFlow,
  signOutSafely,
  verifyAccountOtp,
  verifyAndDeleteAccount,
} from "@/lib/auth/account-repository"

const anonymousUser = {
  id: "anonymous-user",
  is_anonymous: true,
} as User
const permanentUser = {
  id: "permanent-user",
  email: "student@example.com",
  is_anonymous: false,
} as User

describe("account repository", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getSession.mockResolvedValue({
      data: { session: { user: anonymousUser } },
      error: null,
    })
    mocks.updateUser.mockResolvedValue({
      data: { user: anonymousUser },
      error: null,
    })
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null })
    mocks.verifyOtp.mockResolvedValue({
      data: { user: permanentUser, session: { user: permanentUser } },
      error: null,
    })
    mocks.signOut.mockResolvedValue({ error: null })
    mocks.ensureSettings.mockResolvedValue({})
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "prepare_account_merge")
        return Promise.resolve({ data: "2026-09-08T10:10:00Z", error: null })
      if (name === "refresh_account_merge")
        return Promise.resolve({ data: "2026-09-08T10:10:00Z", error: null })
      if (name === "prepare_account_deletion")
        return Promise.resolve({ data: "2026-09-08T10:10:00Z", error: null })
      if (name === "refresh_account_deletion")
        return Promise.resolve({ data: "2026-09-08T10:10:00Z", error: null })
      if (name === "consume_account_merge")
        return Promise.resolve({
          data: {
            tasks: 2,
            sessions: 3,
            behavior_events: 4,
            reminder_events: 1,
            reviews: 2,
          },
          error: null,
        })
      if (name === "touch_my_activity")
        return Promise.resolve({ data: "2026-09-08T10:00:00Z", error: null })
      if (name === "delete_my_account")
        return Promise.resolve({ data: null, error: null })
      if (name === "pause_study_session_for_navigation")
        return Promise.resolve({ data: {}, error: null })
      return Promise.resolve({ data: null, error: null })
    })
    mocks.select.mockReturnValue({ eq: mocks.eq })
    mocks.eq.mockReturnValue({ maybeSingle: mocks.maybeSingle })
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it("links a new email to the anonymous identity without replacing its id", async () => {
    const flow = await beginEmailAccountFlow("Student@example.com", "captcha")

    expect(flow).toMatchObject({
      kind: "upgrade",
      email: "student@example.com",
      sourceUserId: "anonymous-user",
    })
    expect(mocks.updateUser).toHaveBeenCalledWith({
      email: "student@example.com",
    })
    expect(mocks.signInWithOtp).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "prepare_account_merge",
      expect.anything(),
    )
  })

  it("requires an explicit confirmation before preparing an existing-account merge", async () => {
    mocks.updateUser.mockResolvedValue({
      data: { user: null },
      error: { code: "email_exists", message: "email already exists" },
    })

    const flow = await beginEmailAccountFlow("student@example.com", "captcha")

    expect(flow).toMatchObject({
      kind: "confirm_merge",
      email: "student@example.com",
      sourceUserId: "anonymous-user",
    })
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "prepare_account_merge",
      expect.anything(),
    )
    expect(mocks.signInWithOtp).not.toHaveBeenCalled()
  })

  it("prepares a one-time merge token before sending OTP after confirmation", async () => {
    const prepared = createPreparedAccountMergeFlow({
      kind: "confirm_merge",
      email: "student@example.com",
      sentAt: Date.now(),
      sourceUserId: "anonymous-user",
    })
    const flow = await confirmAccountMerge(prepared, "captcha")

    expect(flow.kind).toBe("merge")
    expect(flow.mergeSecret).toMatch(/^[a-f0-9]{64}$/)
    expect(mocks.rpc).toHaveBeenCalledWith("prepare_account_merge", {
      p_token: flow.mergeSecret,
      p_target_email: "student@example.com",
    })
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email: "student@example.com",
      options: { shouldCreateUser: false, captchaToken: "captcha" },
    })
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInWithOtp.mock.invocationCallOrder[0],
    )
  })

  it("refreshes the same merge bearer before every OTP resend", async () => {
    const flow = {
      kind: "merge" as const,
      email: "student@example.com",
      sentAt: Date.now() - 61_000,
      sourceUserId: "anonymous-user",
      mergeSecret: "c".repeat(64),
    }

    const result = await resendAccountOtp(flow, "captcha")

    expect(mocks.rpc).toHaveBeenCalledWith("refresh_account_merge", {
      p_token: flow.mergeSecret,
    })
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInWithOtp.mock.invocationCallOrder[0],
    )
    expect(result.mergeSecret).toBe(flow.mergeSecret)
  })

  it("verifies the target account and consumes the merge secret once", async () => {
    const result = await verifyAccountOtp(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
      },
      "123456",
    )

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      email: "student@example.com",
      token: "123456",
      type: "email",
    })
    expect(mocks.rpc).toHaveBeenCalledWith("consume_account_merge", {
      p_token: "b".repeat(64),
    })
    expect(result.merge).toEqual({
      tasks: 2,
      sessions: 3,
      behaviorEvents: 4,
      reminderEvents: 1,
      reviews: 2,
    })
    expect(mocks.ensureSettings).toHaveBeenCalledWith("permanent-user")
  })

  it("does not resume a stale pending flow under a different email account", async () => {
    const result = await resumePendingAccountFlow(
      {
        kind: "sign_in",
        email: "other@example.com",
        sentAt: Date.now(),
      },
      permanentUser,
    )

    expect(result).toBeNull()
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "consume_account_merge",
      expect.anything(),
    )
  })

  it("pauses a running session before signing out of this device", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { id: "running-session", status: "running" },
      error: null,
    })

    await signOutSafely()

    expect(mocks.rpc).toHaveBeenCalledWith(
      "pause_study_session_for_navigation",
      { p_session_id: "running-session" },
    )
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signOut.mock.invocationCallOrder[0],
    )
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" })
  })

  it("requires OTP verification before deleting the current account", async () => {
    const flow = createPreparedAccountDeletionFlow(permanentUser)
    await requestAccountDeletionOtp(permanentUser, flow, "captcha")

    expect(mocks.rpc).toHaveBeenCalledWith("prepare_account_deletion", {
      p_token: flow.deletionSecret,
    })
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signInWithOtp.mock.invocationCallOrder[0],
    )

    await verifyAndDeleteAccount({ ...flow, sentAt: Date.now() }, "654321")

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      email: "student@example.com",
      token: "654321",
      type: "email",
    })
    expect(mocks.rpc).toHaveBeenCalledWith("delete_my_account", {
      p_token: flow.deletionSecret,
    })
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" })
  })
})
