import { act, render, screen, waitFor } from "@testing-library/react"
import type { AuthChangeEvent, Session } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authCallback: null as
    ((event: AuthChangeEvent, session: Session | null) => void) | null,
  getSession: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  signInAnonymously: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock("@/lib/data/study-repository", () => ({
  ensureSettings: vi.fn(),
}))

vi.mock("@/lib/supabase/client", () => ({
  hasSupabaseConfig: () => true,
  withSupabaseAuthMutationLock: <T,>(operation: () => Promise<T>) =>
    operation(),
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
      getUser: mocks.getUser,
      signOut: mocks.signOut,
      signInAnonymously: mocks.signInAnonymously,
      onAuthStateChange: (
        callback: (event: AuthChangeEvent, session: Session | null) => void,
      ) => {
        mocks.authCallback = callback
        return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }
      },
    },
  }),
}))

import {
  ExperienceProvider,
  useExperience,
} from "@/components/experience/experience-provider"

function StatusProbe() {
  const { error, status, user } = useExperience()
  return (
    <>
      <p>{`${status}:${user?.id ?? "none"}`}</p>
      <p>{error ?? "no-error"}</p>
    </>
  )
}

describe("ExperienceProvider auth lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.authCallback = null
    mocks.getSession.mockResolvedValue({
      data: {
        session: { user: { id: "anonymous-user", is_anonymous: true } },
      },
      error: null,
    })
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "anonymous-user", is_anonymous: true } },
      error: null,
    })
    mocks.signOut.mockResolvedValue({ error: null })
  })

  it("validates a cached identity with the auth server before becoming ready", async () => {
    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )

    await screen.findByText("ready:anonymous-user")
    expect(mocks.getUser).toHaveBeenCalledOnce()
  })

  it("returns to the anonymous gate when the local identity disappears", async () => {
    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )

    await screen.findByText("ready:anonymous-user")

    act(() => {
      mocks.authCallback?.("SIGNED_OUT", null)
    })

    expect(screen.getByText("needs_gate:none")).toBeInTheDocument()
  })

  it("clears a definitively deleted cached identity and returns to the gate", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error("User not found"), {
        code: "user_not_found",
        status: 404,
      }),
    })

    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )

    await screen.findByText("needs_gate:none")
    expect(
      screen.getByText(/若刚完成记录合并，请通过邮箱验证恢复/),
    ).toBeInTheDocument()
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" })
  })

  it("keeps an uncertain cached identity blocked when server validation fails", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: Object.assign(new Error("Failed to fetch"), {
        code: "network_error",
        status: 503,
      }),
    })

    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )

    await screen.findByText("error:none")
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument()
    expect(mocks.signOut).not.toHaveBeenCalled()
  })

  it("does not clear a different account that signs in while stale cleanup waits", async () => {
    const sourceSession = {
      data: {
        session: { user: { id: "anonymous-user", is_anonymous: true } },
      },
      error: null,
    }
    const foreignSession = {
      data: {
        session: { user: { id: "other-account", is_anonymous: false } },
      },
      error: null,
    }
    mocks.getSession
      .mockResolvedValueOnce(sourceSession)
      .mockResolvedValueOnce(foreignSession)
      .mockResolvedValue(foreignSession)
    mocks.getUser
      .mockResolvedValueOnce({
        data: { user: null },
        error: Object.assign(new Error("User not found"), {
          code: "user_not_found",
          status: 404,
        }),
      })
      .mockResolvedValue({
        data: { user: { id: "other-account", is_anonymous: false } },
        error: null,
      })

    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )

    await screen.findByText("ready:other-account")
    expect(mocks.signOut).not.toHaveBeenCalled()
  })

  it("does not call the server user endpoint without a cached session", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    })

    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )

    await screen.findByText("needs_gate:none")
    expect(mocks.getUser).not.toHaveBeenCalled()
  })

  it("revalidates a session received from another tab", async () => {
    render(
      <ExperienceProvider>
        <StatusProbe />
      </ExperienceProvider>,
    )
    await screen.findByText("ready:anonymous-user")

    mocks.getSession.mockResolvedValue({
      data: {
        session: { user: { id: "email-user", is_anonymous: false } },
      },
      error: null,
    })
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "email-user", is_anonymous: false } },
      error: null,
    })

    act(() => {
      mocks.authCallback?.("SIGNED_IN", {
        user: { id: "email-user", is_anonymous: false },
      } as Session)
    })

    await waitFor(() =>
      expect(screen.getByText("ready:email-user")).toBeInTheDocument(),
    )
    expect(mocks.getUser).toHaveBeenCalledTimes(2)
  })
})
