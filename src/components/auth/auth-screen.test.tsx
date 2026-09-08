import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { User } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  beginEmailAccountFlow: vi.fn(),
  cancelPendingAccountFlow: vi.fn(),
  clearDefinitivelyStaleAuthSession: vi.fn(),
  confirmAccountMerge: vi.fn(),
  createPreparedAccountMergeFlow: vi.fn(),
  getAccountTransferSummary: vi.fn(),
  isDefinitiveAccountRpcRollback: vi.fn(),
  isDefinitivelyMissingAuthUser: vi.fn(),
  isMergeResultUncertain: vi.fn(),
  isMergeSourceRestored: vi.fn(),
  isMergeTargetReverificationRequired: vi.fn(),
  resumePendingAccountFlow: vi.fn(),
  touchMyActivity: vi.fn(),
  replace: vi.fn(),
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))

vi.mock("@/lib/auth/account-repository", () => ({
  beginEmailAccountFlow: mocks.beginEmailAccountFlow,
  cancelPendingAccountFlow: mocks.cancelPendingAccountFlow,
  clearDefinitivelyStaleAuthSession: mocks.clearDefinitivelyStaleAuthSession,
  confirmAccountMerge: mocks.confirmAccountMerge,
  createPreparedAccountDeletionFlow: vi.fn(),
  createPreparedAccountMergeFlow: mocks.createPreparedAccountMergeFlow,
  getAccountTransferSummary: mocks.getAccountTransferSummary,
  isDefinitiveAccountRpcRollback: mocks.isDefinitiveAccountRpcRollback,
  isDefinitivelyMissingAuthUser: mocks.isDefinitivelyMissingAuthUser,
  isMergeResultUncertain: mocks.isMergeResultUncertain,
  isMergeSourceRestored: mocks.isMergeSourceRestored,
  isMergeTargetReverificationRequired:
    mocks.isMergeTargetReverificationRequired,
  requestAccountDeletionOtp: vi.fn(),
  resendAccountOtp: vi.fn(),
  resumePendingAccountFlow: mocks.resumePendingAccountFlow,
  signOutSafely: vi.fn(),
  touchMyActivity: mocks.touchMyActivity,
  verifyAccountOtp: vi.fn(),
  verifyAndDeleteAccount: vi.fn(),
}))

vi.mock("@/lib/supabase/client", () => ({
  withSupabaseAuthMutationLock: <T,>(operation: () => Promise<T>) =>
    operation(),
  withAccountMergeStorageLock: <T,>(operation: () => Promise<T> | T) =>
    operation(),
  hasSupabaseConfig: () => true,
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      signOut: mocks.signOut,
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: mocks.unsubscribe } },
      }),
    },
  }),
}))

import { AuthScreen } from "@/components/auth/auth-screen"

const anonymousUser = {
  id: "anonymous-user",
  is_anonymous: true,
} as User
describe("AuthScreen existing-account confirmation", () => {
  beforeEach(() => {
    if (!globalThis.localStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: globalThis.sessionStorage,
      })
    }
    vi.clearAllMocks()
    sessionStorage.clear()
    localStorage.clear()
    mocks.getSession.mockResolvedValue({
      data: { session: { user: anonymousUser } },
      error: null,
    })
    mocks.getUser.mockResolvedValue({
      data: { user: anonymousUser },
      error: null,
    })
    mocks.signOut.mockResolvedValue({ error: null })
    mocks.isDefinitivelyMissingAuthUser.mockReturnValue(false)
    mocks.isDefinitiveAccountRpcRollback.mockReturnValue(false)
    mocks.touchMyActivity.mockResolvedValue("2026-09-08T10:00:00Z")
    mocks.getAccountTransferSummary.mockResolvedValue({
      tasks: 2,
      sessions: 3,
      behaviorEvents: 1,
      reviews: 1,
      hasActiveSession: false,
    })
    mocks.beginEmailAccountFlow.mockResolvedValue({
      kind: "confirm_merge",
      email: "student@example.com",
      sentAt: 1_700_000_000_000,
      sourceUserId: "anonymous-user",
    })
    mocks.confirmAccountMerge.mockResolvedValue({
      kind: "merge",
      email: "student@example.com",
      sentAt: Date.now(),
      preparedAt: Date.now(),
      sourceUserId: "anonymous-user",
      mergeSecret: "a".repeat(64),
    })
    mocks.createPreparedAccountMergeFlow.mockReturnValue({
      kind: "merge",
      email: "student@example.com",
      sentAt: 0,
      preparedAt: Date.now(),
      sourceUserId: "anonymous-user",
      mergeSecret: "a".repeat(64),
    })
    mocks.cancelPendingAccountFlow.mockResolvedValue(true)
    mocks.clearDefinitivelyStaleAuthSession.mockResolvedValue("cleared")
    mocks.isMergeResultUncertain.mockReturnValue(false)
    mocks.isMergeSourceRestored.mockReturnValue(false)
    mocks.isMergeTargetReverificationRequired.mockReturnValue(false)
    mocks.resumePendingAccountFlow.mockResolvedValue(null)
  })

  it("shows record counts and waits for explicit consent before creating a merge token", async () => {
    const user = userEvent.setup()
    render(<AuthScreen />)

    await screen.findByRole("heading", { name: "保存并同步记录" })
    await user.type(
      screen.getByRole("textbox", { name: "邮箱" }),
      "student@example.com",
    )
    await user.click(screen.getByRole("button", { name: "发送验证码" }))

    expect(
      await screen.findByRole("heading", { name: "确认合并当前记录" }),
    ).toBeInTheDocument()
    expect(screen.getByText(/2 个任务 · 3 次学习时段/)).toBeInTheDocument()
    expect(mocks.confirmAccountMerge).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "确认并发送验证码" }))

    expect(mocks.confirmAccountMerge).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "merge" }),
      undefined,
    )
    expect(
      localStorage.getItem("studytrace.pending-account-merge-durable.v2"),
    ).toContain("a".repeat(64))
    expect(
      localStorage.getItem("studytrace.pending-account-merge-durable.v2"),
    ).not.toContain("access_token")
    expect(
      await screen.findByRole("heading", { name: "输入邮件中的六位数字" }),
    ).toBeInTheDocument()
  })

  it("revokes a prepared merge before allowing an immediate restart", async () => {
    const user = userEvent.setup()
    sessionStorage.setItem(
      "studytrace.pending-account-flow.v1",
      JSON.stringify({
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        preparedAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "a".repeat(64),
      }),
    )
    render(<AuthScreen />)

    await user.click(await screen.findByRole("button", { name: "更换邮箱" }))

    expect(mocks.cancelPendingAccountFlow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "merge", mergeSecret: "a".repeat(64) }),
    )
    expect(
      await screen.findByText("已取消本次验证，可以立即重新发起。"),
    ).toBeInTheDocument()
    expect(
      sessionStorage.getItem("studytrace.pending-account-flow.v1"),
    ).toBeNull()
  })

  it("keeps the pending flow when server-side cancellation fails", async () => {
    const user = userEvent.setup()
    mocks.cancelPendingAccountFlow.mockRejectedValueOnce(
      new Error("cancel failed"),
    )
    sessionStorage.setItem(
      "studytrace.pending-account-flow.v1",
      JSON.stringify({
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        preparedAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "a".repeat(64),
      }),
    )
    render(<AuthScreen />)

    await user.click(await screen.findByRole("button", { name: "更换邮箱" }))

    expect(
      await screen.findByText(
        "操作未完成，请稍后重试；如果问题持续，请重新打开账号页",
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "输入邮件中的六位数字" }),
    ).toBeInTheDocument()
    expect(
      sessionStorage.getItem("studytrace.pending-account-flow.v1"),
    ).not.toBeNull()
  })

  it("keeps the only recovery bearer when cancellation is not authorized", async () => {
    const user = userEvent.setup()
    mocks.cancelPendingAccountFlow.mockResolvedValueOnce(false)
    sessionStorage.setItem(
      "studytrace.pending-account-flow.v1",
      JSON.stringify({
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now(),
        preparedAt: Date.now(),
        sourceUserId: "anonymous-user",
        mergeSecret: "a".repeat(64),
      }),
    )
    render(<AuthScreen />)

    await user.click(await screen.findByRole("button", { name: "更换邮箱" }))

    expect(await screen.findByText(/请保留当前页面并刷新/)).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "输入邮件中的六位数字" }),
    ).toBeInTheDocument()
    expect(
      sessionStorage.getItem("studytrace.pending-account-flow.v1"),
    ).not.toBeNull()
  })

  it("blocks cancellation while an uncertain merge can only retry its receipt", async () => {
    const uncertainError = Object.assign(new Error("Gateway timeout"), {
      mergeAttemptOutcome: "result_uncertain",
    })
    mocks.getSession.mockResolvedValue({
      data: { session: { user: anonymousUser } },
      error: null,
    })
    mocks.resumePendingAccountFlow.mockRejectedValue(uncertainError)
    mocks.isMergeResultUncertain.mockImplementation(
      (error) => error === uncertainError,
    )
    sessionStorage.setItem(
      "studytrace.pending-account-flow.v1",
      JSON.stringify({
        kind: "merge",
        email: "student@example.com",
        sentAt: Date.now() - 11 * 60_000,
        sourceUserId: "anonymous-user",
        mergeSecret: "a".repeat(64),
        mergeRecoveryRequired: true,
      }),
    )
    sessionStorage.setItem(
      "studytrace.pending-account-merge-recovery.v1",
      JSON.stringify({
        sourceUserId: "anonymous-user",
        targetUserId: "permanent-user",
        email: "student@example.com",
        accessToken: "target-access-token",
        refreshToken: "target-refresh-token",
        capturedAt: Date.now() - 11 * 60_000,
      }),
    )

    render(<AuthScreen />)

    expect(
      await screen.findByRole("heading", { name: "正在确认合并结果" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "重试确认合并" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "更换邮箱" }),
    ).not.toBeInTheDocument()
    expect(
      sessionStorage.getItem("studytrace.pending-account-flow.v1"),
    ).toContain('"mergeRecoveryRequired":true')
    expect(
      sessionStorage.getItem("studytrace.pending-account-merge-recovery.v1"),
    ).not.toBeNull()
  })
})
