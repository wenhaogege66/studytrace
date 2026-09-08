import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useCheckpointHeartbeat } from "./use-checkpoint-heartbeat"

function Harness({
  checkpoint,
  enabled = true,
  runImmediately = false,
}: {
  checkpoint: () => void
  enabled?: boolean
  runImmediately?: boolean
}) {
  useCheckpointHeartbeat(checkpoint, { enabled, runImmediately })
  return null
}

describe("useCheckpointHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("fires at 60 seconds even when the timer screen continuously re-renders", () => {
    const callbacks = Array.from({ length: 61 }, () => vi.fn())
    const view = render(<Harness checkpoint={callbacks[0]} />)

    for (let second = 1; second < 60; second += 1) {
      act(() => view.rerender(<Harness checkpoint={callbacks[second]} />))
      act(() => vi.advanceTimersByTime(1_000))
    }

    act(() => view.rerender(<Harness checkpoint={callbacks[60]} />))
    act(() => vi.advanceTimersByTime(1_000))

    expect(
      callbacks.slice(0, 60).every((callback) => !callback.mock.calls.length),
    ).toBe(true)
    expect(callbacks[60]).toHaveBeenCalledOnce()
  })

  it("reconciles immediately when a loaded running session becomes enabled", () => {
    const checkpoint = vi.fn()
    const view = render(
      <Harness checkpoint={checkpoint} enabled={false} runImmediately={true} />,
    )

    expect(checkpoint).not.toHaveBeenCalled()
    act(() =>
      view.rerender(
        <Harness
          checkpoint={checkpoint}
          enabled={true}
          runImmediately={true}
        />,
      ),
    )

    expect(checkpoint).toHaveBeenCalledOnce()
  })
})
