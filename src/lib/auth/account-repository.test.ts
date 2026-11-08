import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signUp: vi.fn(),
  signIn: vi.fn(),
  setSession: vi.fn(),
  transientSignOut: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  transientRpc: vi.fn(),
  maybeSingle: vi.fn(),
}))
vi.mock("@/lib/supabase/client", () => ({
  withSupabaseAuthMutationLock: <T>(fn: () => Promise<T>) => fn(),
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
      setSession: mocks.setSession,
      signOut: mocks.signOut,
    },
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.maybeSingle }) }),
    }),
  }),
  createTransientSupabase: () => ({
    auth: {
      signUp: mocks.signUp,
      signInWithPassword: mocks.signIn,
      getUser: mocks.getUser,
      signOut: mocks.transientSignOut,
    },
    rpc: mocks.transientRpc,
  }),
}))
import {
  authenticatePasswordAccount,
  deletePasswordAccount,
  signOutSafely,
} from "./account-repository"

const anonymous = { id: "anonymous", is_anonymous: true }
const target = { id: "target", is_anonymous: false, email: "you@example.com" }
const sourceSession = {
  user: anonymous,
  access_token: "anon-access",
  refresh_token: "anon-refresh",
}
const targetSession = {
  user: target,
  access_token: "target-access",
  refresh_token: "target-refresh",
}
const credentials = {
  mode: "sign_in" as const,
  email: "you@example.com",
  password: "safe-password",
}

describe("independent password accounts", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getSession.mockResolvedValue({
      data: { session: sourceSession },
      error: null,
    })
    mocks.signIn.mockResolvedValue({
      data: { user: target, session: targetSession },
      error: null,
    })
    mocks.signUp.mockResolvedValue({
      data: { user: target, session: targetSession },
      error: null,
    })
    mocks.getUser.mockResolvedValue({ data: { user: target }, error: null })
    mocks.setSession.mockResolvedValue({
      data: { session: targetSession },
      error: null,
    })
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null })
    mocks.rpc.mockResolvedValue({ error: null })
    mocks.transientRpc.mockResolvedValue({ error: null })
    mocks.transientSignOut.mockResolvedValue({ error: null })
    mocks.signOut.mockResolvedValue({ error: null })
  })
  it("validates on a transient client, pauses, then commits without revoking that session", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { id: "running" },
      error: null,
    })
    await authenticatePasswordAccount(credentials)
    expect(mocks.rpc).toHaveBeenCalledWith(
      "pause_study_session_for_navigation",
      { p_session_id: "running" },
    )
    expect(mocks.setSession).toHaveBeenCalledWith({
      access_token: "target-access",
      refresh_token: "target-refresh",
    })
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setSession.mock.invocationCallOrder[0],
    )
    expect(mocks.transientSignOut).not.toHaveBeenCalled()
  })
  it("wrong password preserves anonymous storage and does not pause its session", async () => {
    mocks.signIn.mockResolvedValue({
      data: { session: null },
      error: new Error("Invalid login credentials"),
    })
    await expect(authenticatePasswordAccount(credentials)).rejects.toThrow(
      "Invalid login",
    )
    expect(mocks.setSession).not.toHaveBeenCalled()
    expect(mocks.signOut).not.toHaveBeenCalled()
    expect(mocks.maybeSingle).not.toHaveBeenCalled()
  })
  it("email confirmation enabled fails clearly without replacing anonymous identity", async () => {
    mocks.signUp.mockResolvedValue({
      data: { user: target, session: null },
      error: null,
    })
    await expect(
      authenticatePasswordAccount({ ...credentials, mode: "sign_up" }),
    ).rejects.toThrow("邮箱确认")
    expect(mocks.setSession).not.toHaveBeenCalled()
  })
  it("rejects cross-tab identity changes before commit", async () => {
    mocks.getSession
      .mockResolvedValueOnce({ data: { session: sourceSession }, error: null })
      .mockResolvedValueOnce({ data: { session: targetSession }, error: null })
    await expect(authenticatePasswordAccount(credentials)).rejects.toThrow(
      "其他页面",
    )
    expect(mocks.setSession).not.toHaveBeenCalled()
  })
  it("does not switch when safe pause fails", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { id: "running" },
      error: null,
    })
    mocks.rpc.mockResolvedValue({ error: new Error("pause failed") })
    await expect(authenticatePasswordAccount(credentials)).rejects.toThrow(
      "pause failed",
    )
    expect(mocks.setSession).not.toHaveBeenCalled()
  })
  it("restores source tokens if handoff fails", async () => {
    mocks.setSession.mockResolvedValueOnce({
      error: new Error("handoff failed"),
    })
    await expect(authenticatePasswordAccount(credentials)).rejects.toThrow(
      "handoff failed",
    )
    expect(mocks.setSession).toHaveBeenLastCalledWith({
      access_token: "anon-access",
      refresh_token: "anon-refresh",
    })
  })
  it("sign-out waits for successful pause and leaves identity on failure", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { id: "running" },
      error: null,
    })
    mocks.rpc.mockResolvedValue({ error: new Error("pause failed") })
    await expect(signOutSafely()).rejects.toThrow("pause failed")
    expect(mocks.signOut).not.toHaveBeenCalled()
  })
  it("deletes through a fresh transient password session, never SQL password args", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: targetSession },
      error: null,
    })
    await deletePasswordAccount("safe-password")
    expect(mocks.transientRpc).toHaveBeenCalledWith(
      "delete_my_password_account",
    )
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" })
    expect(mocks.setSession).not.toHaveBeenCalled()
  })
  it("wrong password cannot delete or replace the current account", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: targetSession },
      error: null,
    })
    mocks.signIn.mockResolvedValue({
      data: { session: null },
      error: new Error("invalid"),
    })
    await expect(deletePasswordAccount("bad-password")).rejects.toThrow(
      "invalid",
    )
    expect(mocks.transientRpc).not.toHaveBeenCalled()
    expect(mocks.signOut).not.toHaveBeenCalled()
  })
  it("cannot delete a different user returned by a stale transient result", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: targetSession },
      error: null,
    })
    mocks.getUser.mockResolvedValue({
      data: { user: { ...target, id: "other" } },
      error: null,
    })
    await expect(deletePasswordAccount("safe-password")).rejects.toThrow(
      "不一致",
    )
    expect(mocks.transientRpc).not.toHaveBeenCalled()
  })
})
