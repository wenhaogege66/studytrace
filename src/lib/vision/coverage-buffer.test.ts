import { describe, expect, it, vi } from "vitest"
import { createCoverageBuffer } from "./coverage-buffer"

describe("valid observation coverage buffer", () => {
  it("ignores gaps and invalid deltas, batches real samples only", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const buffer = createCoverageBuffer()
    buffer.add(250)
    buffer.add(10_000)
    buffer.add(Number.NaN)
    buffer.add(-1)
    await buffer.flush(send)
    expect(send).toHaveBeenCalledExactlyOnceWith(1, 250)
  })
  it("retries a lost reply with the same replay-safe sequence", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValue(undefined)
    const buffer = createCoverageBuffer()
    buffer.add(1000)
    await buffer.flush(send)
    expect(send.mock.calls).toEqual([
      [1, 1000],
      [1, 1000],
    ])
    buffer.add(250)
    await buffer.flush(send)
    expect(send).toHaveBeenLastCalledWith(2, 250)
  })
  it("serializes concurrent flushes and starts a new camera run at one", async () => {
    let resolve!: () => void
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done
          }),
      )
      .mockResolvedValue(undefined)
    const buffer = createCoverageBuffer()
    buffer.add(250)
    const first = buffer.flush(send)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    buffer.add(500)
    const second = buffer.flush(send)
    expect(send).toHaveBeenCalledTimes(1)
    resolve()
    await Promise.all([first, second])
    expect(send.mock.calls).toEqual([
      [1, 250],
      [2, 500],
    ])
    buffer.reset()
    buffer.add(250)
    await buffer.flush(send)
    expect(send).toHaveBeenLastCalledWith(1, 250)
  })
})
