import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { User } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  beginEmailAccountFlow: vi.fn(),
  confirmAccountMerge: vi.fn(),
  createPreparedAccountMergeFlow: vi.fn(),
  getAccountTransferSummary: vi.fn(),
  touchMyActivity: vi.fn(),
  replace: vi.fn(),
  getSession: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))

vi.mock("@/lib/auth/account-repository", () => ({
  beginEmailAccountFlow: mocks.beginEmailAccountFlow,
  confirmAccountMerge: mocks.confirmAccountMerge,
  createPreparedAccountDeletionFlow: vi.fn(),
  createPreparedAccountMergeFlow: mocks.createPreparedAccountMergeFlow,
  getAccountTransferSummary: mocks.getAccountTransferSummary,
  requestAccountDeletionOtp: vi.fn(),
  resendAccountOtp: vi.fn(),
  resumePendingAccountFlow: vi.fn(),
  signOutSafely: vi.fn(),
  touchMyActivity: mocks.touchMyActivity,
  verifyAccountOtp: vi.fn(),
  verifyAndDeleteAccount: vi.fn(),
}))

vi.mock("@/lib/supabase/client", () => ({
  hasSupabaseConfig: () => true,
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
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
    vi.clearAllMocks()
    sessionStorage.clear()
    mocks.getSession.mockResolvedValue({
      data: { session: { user: anonymousUser } },
      error: null,
    })
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
      await screen.findByRole("heading", { name: "输入邮件中的六位数字" }),
    ).toBeInTheDocument()
  })
})
