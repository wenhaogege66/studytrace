export function createCoverageBuffer() {
  let pending = 0
  let sequence = 0
  let inFlight: Promise<void> | null = null
  return {
    add(deltaMs: number) {
      if (Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs <= 1000)
        pending = Math.min(30_000, pending + Math.floor(deltaMs))
      return pending
    },
    reset() {
      pending = 0
      sequence = 0
    },
    flush(
      send: (sequence: number, validMs: number) => Promise<void>,
    ): Promise<void> {
      const operation = (inFlight ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          for (let batch = 0; pending > 0 && batch < 3; batch++) {
            const amount = Math.min(10_000, pending)
            pending -= amount
            const current = ++sequence
            // Replay the same sequence once if a response is lost.
            await send(current, amount).catch(() => send(current, amount))
          }
        })
      inFlight = operation
      return operation.finally(() => {
        if (inFlight === operation) inFlight = null
      })
    },
  }
}
