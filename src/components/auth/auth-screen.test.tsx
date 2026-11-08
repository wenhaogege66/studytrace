import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  remove: vi.fn(),
  signOut: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  user: { id: "anonymous", is_anonymous: true } as {
    id: string
    is_anonymous: boolean
    email?: string
  },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}))
vi.mock("@/components/experience/experience-provider", () => ({
  useExperience: () => ({ user: mocks.user, status: "ready" }),
}))
vi.mock("@/lib/auth/account-repository", () => ({
  authenticatePasswordAccount: mocks.authenticate,
  deletePasswordAccount: mocks.remove,
  signOutSafely: mocks.signOut,
}))
import { AuthScreen } from "./auth-screen"

function setup() {
  const client = new QueryClient()
  client.setQueryData(["old-user"], "private old data")
  render(
    <QueryClientProvider client={client}>
      <AuthScreen />
    </QueryClientProvider>,
  )
  return client
}
describe("password account screen", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.user = { id: "anonymous", is_anonymous: true }
  })
  it("explains independent identities and no email recovery", () => {
    setup()
    expect(screen.getByText(/临时记录不会迁入/)).toBeInTheDocument()
    expect(screen.getAllByText(/本版不验证邮箱归属/).length).toBeGreaterThan(0)
    expect(
      screen.queryByRole("button", { name: /发送验证码/ }),
    ).not.toBeInTheDocument()
  })
  it("successful login clears old cached data", async () => {
    const client = setup()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("邮箱"), "you@example.com")
    await user.type(screen.getByLabelText("密码"), "safe-password")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "登录并进入学习计划" }))
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "sign_in",
        email: "you@example.com",
        password: "safe-password",
      }),
    )
    expect(client.getQueryData(["old-user"])).toBeUndefined()
    expect(mocks.replace).toHaveBeenCalledWith("/app")
  })
  it("failed login preserves cache, does not navigate and clears password input", async () => {
    mocks.authenticate.mockRejectedValue(new Error("Invalid login credentials"))
    const client = setup()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("邮箱"), "you@example.com")
    await user.type(screen.getByLabelText("密码"), "safe-password")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "登录并进入学习计划" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("邮箱或密码")
    expect(client.getQueryData(["old-user"])).toBe("private old data")
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(screen.getByLabelText("密码")).toHaveValue("")
  })
  it("registration requires explicit acknowledgment", async () => {
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "注册" }))
    expect(
      screen.getByRole("button", { name: "注册并进入学习计划" }),
    ).toBeDisabled()
    await user.click(screen.getByRole("checkbox"))
    expect(
      screen.getByRole("button", { name: "注册并进入学习计划" }),
    ).toBeEnabled()
  })
  it("account deletion requires a new password and a destructive acknowledgment", async () => {
    mocks.user = {
      id: "permanent",
      is_anonymous: false,
      email: "you@example.com",
    }
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "永久删除账号与记录" }))
    expect(
      screen.getByRole("button", { name: "验证密码并永久删除" }),
    ).toBeDisabled()
    await user.type(screen.getByLabelText("再次输入密码"), "safe-password")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "验证密码并永久删除" }))
    expect(mocks.remove).toHaveBeenCalledWith("safe-password", undefined)
  })
})
