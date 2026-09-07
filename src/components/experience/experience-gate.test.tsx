import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock("@/components/experience/experience-provider", () => ({
  useExperience: () => ({
    begin: vi.fn(),
    error: null,
    retry: vi.fn(),
    status: "needs_gate",
    user: null,
  }),
}))

import { ExperienceGate } from "@/components/experience/experience-gate"

describe("ExperienceGate account recovery entry", () => {
  it("keeps anonymous entry primary and exposes existing email recovery", () => {
    render(
      <ExperienceGate>
        <p>应用内容</p>
      </ExperienceGate>,
    )

    expect(screen.getByRole("button", { name: "开始体验" })).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "已有邮箱记录？验证并恢复" }),
    ).toHaveAttribute("href", "/auth")
  })
})
