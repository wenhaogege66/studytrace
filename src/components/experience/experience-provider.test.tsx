import { act, render, screen } from "@testing-library/react"
import type { AuthChangeEvent, Session } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authCallback: null as
    ((event: AuthChangeEvent, session: Session | null) => void) | null,
  getSession: vi.fn(),
  unsubscribe: vi.fn(),
}))

vi.mock("@/lib/data/study-repository", () => ({
  ensureSettings: vi.fn(),
}))

vi.mock("@/lib/supabase/client", () => ({
  hasSupabaseConfig: () => true,
  getSupabase: () => ({
    auth: {
      getSession: mocks.getSession,
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
  const { status, user } = useExperience()
  return <p>{`${status}:${user?.id ?? "none"}`}</p>
}

describe("ExperienceProvider auth lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.authCallback = null
    mocks.getSession.mockResolvedValue({
      data: { session: { user: { id: "anonymous-user" } } },
      error: null,
    })
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
})
