import type { User } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  ensureSettings: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  transientSignInWithOtp: vi.fn(),
  transientVerifyOtp: vi.fn(),
  resend: vi.fn(),
  setSession: vi.fn(),
  transientSetSession: vi.fn(),
  transientSignOut: vi.fn(),
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
  withSupabaseAuthMutationLock: <T>(operation: () => Promise<T>) => operation(),
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      updateUser: mocks.updateUser,
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
      resend: mocks.resend,
      setSession: mocks.setSession,
      signOut: mocks.signOut,
    },
    rpc: mocks.rpc,
    from: () => ({ select: mocks.select }),
  }),
  createTransientSupabase: () => ({
    auth: {
      signInWithOtp: mocks.transientSignInWithOtp,
      verifyOtp: mocks.transientVerifyOtp,
      setSession: mocks.transientSetSession,
      signOut: mocks.transientSignOut,
    },
    rpc: mocks.rpc,
  }),
}))

import {
  beginEmailAccountFlow,
  cancelPendingAccountFlow,
  confirmAccountMerge,
  createPreparedAccountDeletionFlow,
  createPreparedAccountMergeFlow,
  isMergeResultUncertain,
  isMergeSourceRestored,
  isMergeTargetReverificationRequired,
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
let mainUser: User | null = anonymousUser

describe("account repository", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mainUser = anonymousUser
    mocks.getSession.mockImplementation(() =>
      Promise.resolve({
        data: {
          session: mainUser
            ? {
                access_token:
                  mainUser.id === permanentUser.id
                    ? "target-access-token"
                    : "anonymous-access-token",
                refresh_token:
                  mainUser.id === permanentUser.id
                    ? "target-refresh-token"
                    : "anonymous-refresh-token",
                user: mainUser,
              }
            : null,
        },
        error: null,
      }),
    )
    mocks.updateUser.mockResolvedValue({
      data: { user: anonymousUser },
      error: null,
    })
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null })
    mocks.transientSignInWithOtp.mockResolvedValue({ data: {}, error: null })
    mocks.transientSignOut.mockResolvedValue({ error: null })
    mocks.transientVerifyOtp.mockResolvedValue({
      data: {
        user: permanentUser,
        session: {
          user: permanentUser,
          access_token: "target-access-token",
          refresh_token: "target-refresh-token",
        },
      },
      error: null,
    })
    mocks.verifyOtp.mockResolvedValue({
      data: {
        user: permanentUser,
        session: {
          user: permanentUser,
          access_token: "target-access-token",
          refresh_token: "target-refresh-token",
        },
      },
      error: null,
    })
    mocks.getUser.mockResolvedValue({
      data: { user: anonymousUser },
      error: null,
    })
    mocks.signOut.mockResolvedValue({ error: null })
    mocks.setSession.mockImplementation(() => {
      mainUser = permanentUser
      return Promise.resolve({
        data: {
          session: {
            user: permanentUser,
            access_token: "target-access-token",
            refresh_token: "target-refresh-token",
          },
        },
        error: null,
      })
    })
    mocks.transientSetSession.mockResolvedValue({
      data: {
        session: {
          user: permanentUser,
          access_token: "target-access-token",
          refresh_token: "target-refresh-token",
        },
      },
      error: null,
    })
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
      if (name === "cancel_account_merge")
        return Promise.resolve({ data: true, error: null })
      if (name === "cancel_account_deletion")
        return Promise.resolve({ data: true, error: null })
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
    expect(mocks.transientSignInWithOtp).toHaveBeenCalledWith({
      email: "student@example.com",
      options: { shouldCreateUser: false, captchaToken: "captcha" },
    })
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transientSignInWithOtp.mock.invocationCallOrder[0],
    )
  })

  it("idempotently reprepares the same capability before resending from the source", async () => {
    const flow = {
      kind: "merge" as const,
      email: "student@example.com",
      sentAt: Date.now() - 61_000,
      preparedAt: Date.now() - 61_000,
      sourceUserId: "anonymous-user",
      mergeSecret: "c".repeat(64),
    }

    const result = await resendAccountOtp(flow, "captcha")

    expect(mocks.rpc).toHaveBeenCalledWith("prepare_account_merge", {
      p_token: flow.mergeSecret,
      p_target_email: flow.email,
    })
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transientSignInWithOtp.mock.invocationCallOrder[0],
    )
    expect(result.mergeSecret).toBe(flow.mergeSecret)
  })

  it("does not send an OTP when the merge capability has under one minute left", async () => {
    const flow = {
      kind: "merge" as const,
      email: "student@example.com",
      sentAt: Date.now() - 9 * 60_000,
      preparedAt: Date.now() - 9 * 60_000 - 1,
      sourceUserId: "anonymous-user",
      mergeSecret: "c".repeat(64),
    }

    await expect(resendAccountOtp(flow, "captcha")).rejects.toThrow(
      "记录合并请求已过期",
    )
    expect(mocks.transientSignInWithOtp).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "prepare_account_merge",
      expect.anything(),
    )
  })

  it("revokes a prepared merge on the server before clearing local state", async () => {
    const flow = {
      kind: "merge" as const,
      email: "student@example.com",
      sentAt: Date.now(),
      sourceUserId: "anonymous-user",
      mergeSecret: "c".repeat(64),
    }

    await expect(cancelPendingAccountFlow(flow)).resolves.toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_account_merge", {
      p_token: flow.mergeSecret,
    })
  })

  it("revokes a prepared deletion on the server", async () => {
    const flow = {
      kind: "delete" as const,
      email: "student@example.com",
      sentAt: Date.now(),
      deletionSecret: "d".repeat(64),
    }

    await expect(cancelPendingAccountFlow(flow)).resolves.toBe(true)
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_account_deletion", {
      p_token: flow.deletionSecret,
    })
  })

  it("allows local cancellation before a bearer is prepared", async () => {
    await expect(
      cancelPendingAccountFlow({
        kind: "confirm_merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
      }),
    ).resolves.toBe(true)
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "cancel_account_merge",
      expect.anything(),
    )
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

    expect(mocks.transientVerifyOtp).toHaveBeenCalledWith({
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
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: "target-access-token",
      refresh_token: "target-refresh-token",
    })
    expect(mocks.ensureSettings).not.toHaveBeenCalled()
  })

  it("rejects a durable capability when fresh OTP resolves to a different target user", async () => {
    await expect(
      verifyAccountOtp(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          preparedAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
          mergeTargetUserId: "different-permanent-user",
        },
        "123456",
      ),
    ).rejects.toThrow("无法确认记录合并身份")
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "consume_account_merge",
      expect.anything(),
    )
    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" })
  })

  it("does not consume a merge when persisting the transient target recovery fails", async () => {
    const persistRecovery = vi
      .fn()
      .mockRejectedValue(new Error("durable capability changed"))

    await expect(
      verifyAccountOtp(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          preparedAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
        },
        "123456",
        persistRecovery,
      ),
    ).rejects.toThrow("durable capability changed")

    expect(persistRecovery).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "consume_account_merge",
      expect.anything(),
    )
    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" })
  })

  it("keeps the persistent anonymous session after a definitive merge rollback", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "consume_account_merge") {
        return Promise.resolve({
          data: null,
          error: {
            code: "54000",
            message: "Account merge would exceed the data limit for tasks",
          },
        })
      }
      return Promise.resolve({ data: null, error: null })
    })

    await expect(
      verifyAccountOtp(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
        },
        "123456",
      ),
    ).rejects.toThrow("exceed the data limit")

    expect(mocks.setSession).not.toHaveBeenCalled()
    expect(mocks.getUser).toHaveBeenCalledTimes(1)
    expect(mocks.transientSignOut).toHaveBeenCalledWith({ scope: "local" })
  })

  it("keeps the target session when the merge response is uncertain", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "consume_account_merge") {
        return Promise.resolve({
          data: null,
          error: { message: "Failed to fetch" },
        })
      }
      return Promise.resolve({ data: null, error: null })
    })

    await expect(
      verifyAccountOtp(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
        },
        "123456",
      ),
    ).rejects.toThrow("Failed to fetch")

    expect(mocks.setSession).not.toHaveBeenCalled()
    expect(mocks.transientSignOut).not.toHaveBeenCalled()
  })

  it("keeps the source for a definite constraint SQLSTATE", async () => {
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "consume_account_merge") {
        return Promise.resolve({
          data: null,
          error: {
            code: "23514",
            message: "check constraint failed",
          },
        })
      }
      return Promise.resolve({ data: null, error: null })
    })

    await expect(
      verifyAccountOtp(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
        },
        "123456",
      ),
    ).rejects.toThrow("check constraint failed")

    expect(mocks.setSession).not.toHaveBeenCalled()
  })

  it.each(["08007", "40003"])(
    "keeps the target session for completion-unknown SQLSTATE %s",
    async (code) => {
      mocks.rpc.mockImplementation((name: string) => {
        if (name === "consume_account_merge") {
          return Promise.resolve({
            data: null,
            error: { code, message: "transaction result unknown" },
          })
        }
        return Promise.resolve({ data: null, error: null })
      })

      await expect(
        verifyAccountOtp(
          {
            kind: "merge",
            email: "student@example.com",
            sentAt: Date.now(),
            sourceUserId: "anonymous-user",
            mergeSecret: "b".repeat(64),
          },
          "123456",
        ),
      ).rejects.toThrow("transaction result unknown")

      expect(mocks.setSession).not.toHaveBeenCalled()
    },
  )

  it("persists rotated transient target tokens before consuming a receipt", async () => {
    const rotatedSession = {
      user: permanentUser,
      access_token: "rotated-target-access",
      refresh_token: "rotated-target-refresh",
    }
    mocks.transientSetSession.mockResolvedValueOnce({
      data: { session: rotatedSession },
      error: null,
    })
    mocks.setSession.mockImplementationOnce(() => {
      mainUser = permanentUser
      return Promise.resolve({ data: { session: rotatedSession }, error: null })
    })
    const onRecoveryUpdated = vi.fn()

    await resumePendingAccountFlow(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
        mergeRecoveryRequired: true,
      },
      anonymousUser,
      {
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "expired-target-access",
        refreshToken: "old-target-refresh",
        capturedAt: Date.now(),
      },
      onRecoveryUpdated,
    )

    expect(onRecoveryUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "rotated-target-access",
        refreshToken: "rotated-target-refresh",
      }),
    )
    expect(mocks.setSession).toHaveBeenLastCalledWith({
      access_token: "rotated-target-access",
      refresh_token: "rotated-target-refresh",
    })
  })

  it("does not treat a target login plus a capacity rollback as a completed merge", async () => {
    mainUser = permanentUser
    mocks.getUser.mockResolvedValue({
      data: { user: permanentUser },
      error: null,
    })
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "consume_account_merge") {
        return Promise.resolve({
          data: null,
          error: {
            code: "54000",
            message: "Account merge would exceed the data limit for tasks",
          },
        })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const attempt = resumePendingAccountFlow(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
        mergeRecoveryRequired: true,
      },
      permanentUser,
      {
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "target-access",
        refreshToken: "target-refresh",
        capturedAt: Date.now(),
      },
    )

    await expect(attempt).rejects.toSatisfy(isMergeResultUncertain)
    expect(mocks.setSession).not.toHaveBeenCalled()
  })

  it("uses a live exact-target session to read an existing merge receipt without overwriting it", async () => {
    mainUser = permanentUser
    mocks.getUser.mockResolvedValue({
      data: { user: permanentUser },
      error: null,
    })

    const result = await resumePendingAccountFlow(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
        mergeRecoveryRequired: true,
      },
      permanentUser,
      {
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "old-target-access",
        refreshToken: "old-target-refresh",
        capturedAt: Date.now(),
      },
    )

    expect(result?.merge?.tasks).toBe(2)
    expect(mocks.setSession).not.toHaveBeenCalled()
    expect(mocks.transientSetSession).not.toHaveBeenCalled()
  })

  it("falls back to the stored exact receipt session when the same target is logged in elsewhere", async () => {
    mainUser = permanentUser
    mocks.getUser.mockResolvedValue({
      data: { user: permanentUser },
      error: null,
    })
    let consumeAttempts = 0
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "consume_account_merge") {
        consumeAttempts += 1
        if (consumeAttempts === 1) {
          return Promise.resolve({
            data: null,
            error: {
              code: "42501",
              message: "Receipt belongs to another target session",
            },
          })
        }
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
      }
      return Promise.resolve({ data: null, error: null })
    })

    const result = await resumePendingAccountFlow(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
        mergeRecoveryRequired: true,
      },
      permanentUser,
      {
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "receipt-session-access",
        refreshToken: "receipt-session-refresh",
        capturedAt: Date.now(),
      },
    )

    expect(result?.merge?.tasks).toBe(2)
    expect(mocks.transientSetSession).toHaveBeenCalledWith({
      access_token: "receipt-session-access",
      refresh_token: "receipt-session-refresh",
    })
    expect(consumeAttempts).toBe(2)
    expect(mocks.setSession).not.toHaveBeenCalled()
  })

  it("requires fresh target OTP when the merge committed but the persistent session disappeared", async () => {
    mainUser = null

    const attempt = verifyAccountOtp(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
      },
      "123456",
    )

    await expect(attempt).rejects.toSatisfy(isMergeTargetReverificationRequired)
    expect(mocks.setSession).not.toHaveBeenCalled()
  })

  it("returns to OTP when a rotated recovery token is lost but the anonymous source is still valid", async () => {
    mocks.transientSetSession.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error("Invalid Refresh Token"), {
        code: "refresh_token_not_found",
      }),
    })

    const attempt = resumePendingAccountFlow(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
        mergeRecoveryRequired: true,
      },
      anonymousUser,
      {
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "expired-target-access",
        refreshToken: "used-target-refresh",
        capturedAt: Date.now(),
      },
    )

    await expect(attempt).rejects.toSatisfy(isMergeSourceRestored)
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "consume_account_merge",
      expect.anything(),
    )
  })

  it("requires fresh target OTP when the recovery token is lost and the source is explicitly gone", async () => {
    mocks.transientSetSession.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error("Invalid Refresh Token"), {
        code: "refresh_token_not_found",
      }),
    })
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error("User not found"), {
        code: "user_not_found",
        status: 404,
      }),
    })

    const attempt = resumePendingAccountFlow(
      {
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "b".repeat(64),
        mergeRecoveryRequired: true,
      },
      anonymousUser,
      {
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "expired-target-access",
        refreshToken: "used-target-refresh",
        capturedAt: Date.now(),
      },
    )

    await expect(attempt).rejects.toSatisfy(isMergeTargetReverificationRequired)
  })

  it("does not consume a merge if persisting the transient target recovery fails", async () => {
    const storageError = new Error("session storage unavailable")

    await expect(
      verifyAccountOtp(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
        },
        "123456",
        () => {
          throw storageError
        },
      ),
    ).rejects.toBe(storageError)
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "consume_account_merge",
      expect.anything(),
    )
  })

  it("refuses to overwrite an unrelated account during merge recovery", async () => {
    const unrelatedUser = {
      id: "unrelated-user",
      email: "other@example.com",
      is_anonymous: false,
    } as User

    await expect(
      resumePendingAccountFlow(
        {
          kind: "merge",
          email: "student@example.com",
          sentAt: Date.now(),
          sourceUserId: "anonymous-user",
          mergeSecret: "b".repeat(64),
          mergeRecoveryRequired: true,
        },
        unrelatedUser,
        {
          sourceUserId: "anonymous-user",
          targetUserId: "permanent-user",
          email: "student@example.com",
          accessToken: "target-access",
          refreshToken: "target-refresh",
          capturedAt: Date.now(),
        },
      ),
    ).rejects.toThrow("当前账号与待恢复的记录合并不匹配")
    expect(mocks.setSession).not.toHaveBeenCalled()
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
