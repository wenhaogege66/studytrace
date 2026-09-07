import { describe, expect, it } from "vitest"

import {
  createMergeSecret,
  friendlyAccountError,
  maskEmail,
  normalizeEmail,
  normalizeOtp,
  parsePendingAccountFlow,
  serializePendingAccountFlow,
  type PendingAccountFlow,
} from "@/lib/auth/account"

describe("account helpers", () => {
  it("normalizes valid email addresses and rejects malformed input", () => {
    expect(normalizeEmail("  Student@Example.COM ")).toBe("student@example.com")
    expect(() => normalizeEmail("not-an-email")).toThrow("有效的邮箱")
  })

  it("masks the local part without hiding the destination domain", () => {
    expect(maskEmail("student@example.com")).toBe("st•••••@example.com")
    expect(maskEmail("a@example.com")).toBe("a•••@example.com")
  })

  it("keeps only six numeric OTP characters", () => {
    expect(normalizeOtp("12a 34-5678")).toBe("123456")
  })

  it("creates a 256-bit hex merge secret", () => {
    const cryptoSource = {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_, index) => {
          bytes[index] = index
        })
        return bytes
      },
    }
    const secret = createMergeSecret(cryptoSource as Crypto)
    expect(secret).toHaveLength(64)
    expect(secret).toMatch(/^[a-f0-9]{64}$/)
    expect(secret).toContain("00010203")
  })

  it("round-trips a valid pending merge and rejects incomplete bearer data", () => {
    const flow: PendingAccountFlow = {
      kind: "merge",
      email: "student@example.com",
      sentAt: Date.now(),
      sourceUserId: "anonymous-user",
      mergeSecret: "a".repeat(64),
    }
    expect(parsePendingAccountFlow(serializePendingAccountFlow(flow))).toEqual(
      flow,
    )
    expect(
      parsePendingAccountFlow(
        JSON.stringify({
          ...flow,
          mergeSecret: "stored-in-plaintext-but-short",
        }),
      ),
    ).toBeNull()
  })

  it("persists merge confirmation without minting a bearer secret early", () => {
    const confirmation: PendingAccountFlow = {
      kind: "confirm_merge",
      email: "student@example.com",
      sentAt: Date.now(),
      sourceUserId: "anonymous-user",
    }
    expect(
      parsePendingAccountFlow(serializePendingAccountFlow(confirmation)),
    ).toEqual(confirmation)
    expect(
      parsePendingAccountFlow(
        JSON.stringify({ ...confirmation, sourceUserId: undefined }),
      ),
    ).toBeNull()
  })

  it("drops expired OTP state and requires a deletion bearer secret", () => {
    expect(
      parsePendingAccountFlow(
        JSON.stringify({
          kind: "sign_in",
          email: "student@example.com",
          sentAt: Date.now() - 10 * 60 * 1_000,
        }),
      ),
    ).toBeNull()
    expect(
      parsePendingAccountFlow(
        JSON.stringify({
          kind: "delete",
          email: "student@example.com",
          sentAt: Date.now(),
        }),
      ),
    ).toBeNull()
  })

  it("maps recoverable auth failures to actionable copy", () => {
    expect(
      friendlyAccountError(
        Object.assign(new Error("rate limited"), {
          code: "over_email_send_rate_limit",
        }),
      ),
    ).toContain("太频繁")
    expect(friendlyAccountError(new Error("Failed to fetch"))).toContain(
      "检查网络",
    )
  })
})
