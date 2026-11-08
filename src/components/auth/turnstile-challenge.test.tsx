import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@marsidev/react-turnstile", () => ({
  Turnstile: ({
    onError,
    onExpire,
    onSuccess,
    onTimeout,
    onUnsupported,
    scriptOptions,
  }: {
    onError?: () => void
    onExpire?: () => void
    onSuccess?: (token: string) => void
    onTimeout?: () => void
    onUnsupported?: () => void
    scriptOptions?: { onError?: () => void }
  }) => (
    <div aria-label="模拟安全校验">
      <button onClick={() => onSuccess?.("verified-token")}>success</button>
      <button onClick={() => onError?.()}>challenge-error</button>
      <button onClick={() => onExpire?.()}>expired</button>
      <button onClick={() => onTimeout?.()}>timeout</button>
      <button onClick={() => onUnsupported?.()}>unsupported</button>
      <button onClick={() => scriptOptions?.onError?.()}>script-error</button>
    </div>
  ),
}))

import { TurnstileChallenge } from "@/components/auth/turnstile-challenge"

describe("TurnstileChallenge", () => {
  it("blocks on a challenge error and offers an in-place retry", async () => {
    const user = userEvent.setup()
    const onInvalidate = vi.fn()
    const onSuccess = vi.fn()
    render(
      <TurnstileChallenge
        siteKey="test-site-key"
        onInvalidate={onInvalidate}
        onSuccess={onSuccess}
      />,
    )

    await user.click(screen.getByRole("button", { name: "challenge-error" }))

    expect(onInvalidate).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("安全校验未完成")

    await user.click(screen.getByRole("button", { name: "重试安全校验" }))
    expect(
      screen.getByRole("button", { name: "challenge-error" }),
    ).toBeInTheDocument()
  })

  it.each([
    ["expired", "安全校验已过期"],
    ["timeout", "安全校验等待超时"],
    ["unsupported", "当前浏览器不支持安全校验"],
    ["script-error", "安全校验长时间未加载"],
  ])("shows an actionable %s state", async (trigger, message) => {
    const user = userEvent.setup()
    render(<TurnstileChallenge siteKey="test-site-key" onSuccess={vi.fn()} />)

    await user.click(screen.getByRole("button", { name: trigger }))

    expect(screen.getByRole("alert")).toHaveTextContent(message)
    expect(
      screen.getByRole("button", {
        name:
          trigger === "unsupported" || trigger === "script-error"
            ? "重新加载页面"
            : "重试安全校验",
      }),
    ).toBeInTheDocument()
  })
})
