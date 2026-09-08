import { describe, expect, it } from "vitest"

import {
  ACCOUNT_MERGE_PREPARED_TTL_MS,
  createMergeSecret,
  friendlyAccountError,
  maskEmail,
  normalizeEmail,
  normalizeOtp,
  parseAccountMergeDurableFlow,
  parseAccountMergeHandoffMarker,
  parseAnonymousMergeRecovery,
  parsePendingAccountFlow,
  serializeAccountMergeDurableFlow,
  serializeAnonymousMergeRecovery,
  serializeAccountMergeHandoffMarker,
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

  it("keeps an uncertain merge state past the OTP TTL and validates its separate recovery slot", () => {
    const flow: PendingAccountFlow = {
      kind: "merge",
      email: "student@example.com",
      sentAt: Date.now() - 11 * 60_000,
      sourceUserId: "anonymous-user",
      mergeSecret: "a".repeat(64),
      mergeRecoveryRequired: true,
    }
    expect(parsePendingAccountFlow(serializePendingAccountFlow(flow))).toEqual(
      flow,
    )
    expect(
      parsePendingAccountFlow(
        JSON.stringify({
          kind: "sign_in",
          email: "student@example.com",
          sentAt: Date.now(),
          mergeRecoveryRequired: true,
        }),
      ),
    ).toBeNull()

    const recovery = {
      sourceUserId: "anonymous-user",
      targetUserId: "permanent-user",
      email: "student@example.com",
      accessToken: "target-access",
      refreshToken: "target-refresh",
      capturedAt: Date.now(),
    }
    expect(
      parseAnonymousMergeRecovery(serializeAnonymousMergeRecovery(recovery)),
    ).toEqual(recovery)
    expect(
      parseAnonymousMergeRecovery(
        JSON.stringify({ ...recovery, capturedAt: Date.now() + 10 * 60_000 }),
      ),
    ).toBeNull()

    expect(
      parsePendingAccountFlow(
        JSON.stringify({ ...flow, sentAt: Date.now() - 31 * 60_000 }),
      ),
    ).toBeNull()

    const marker = {
      sourceUserId: "anonymous-user",
      targetUserId: "permanent-user",
      email: "student@example.com",
      capturedAt: Date.now(),
    }
    expect(
      parseAccountMergeHandoffMarker(
        serializeAccountMergeHandoffMarker(marker),
      ),
    ).toEqual(marker)
  })

  it("keeps only a ten-minute durable merge capability and rejects stale or tampered values", () => {
    const durable = {
      sourceUserId: "anonymous-user",
      targetUserId: "permanent-user",
      email: "student@example.com",
      mergeSecret: "b".repeat(64),
      preparedAt: Date.now(),
    }
    expect(
      parseAccountMergeDurableFlow(serializeAccountMergeDurableFlow(durable)),
    ).toEqual(durable)
    expect(
      parseAccountMergeDurableFlow(
        JSON.stringify({
          ...durable,
          preparedAt: Date.now() - ACCOUNT_MERGE_PREPARED_TTL_MS - 1,
        }),
      ),
    ).toBeNull()
    expect(
      parseAccountMergeDurableFlow(
        JSON.stringify({ ...durable, mergeSecret: "not-a-capability" }),
      ),
    ).toBeNull()
    expect(
      parseAccountMergeDurableFlow(
        JSON.stringify({ ...durable, targetUserId: durable.sourceUserId }),
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

  it.each([
    ["A fresh email OTP verification is required", "重新完成邮箱验证码验证"],
    [
      "A fresh deletion email OTP verification is required",
      "重新完成邮箱验证码验证",
    ],
    [
      "Another account merge is already in progress",
      "已有一项账号验证正在进行",
    ],
    [
      "Another account deletion verification is in progress",
      "已有一项账号验证正在进行",
    ],
    [
      "Account deletion verification is invalid or expired",
      "账号删除验证已过期",
    ],
    ["A current account session is required", "当前账号会话已失效"],
    ["Authentication required", "当前账号会话已失效"],
    ["Account merge request changed; retry", "当前匿名记录已发生变化"],
    ["Anonymous source account changed during merge", "当前匿名记录已发生变化"],
    ["Only an anonymous account can prepare a merge", "当前匿名记录已发生变化"],
    ["Anonymous source account no longer exists", "当前匿名记录已不存在"],
  ])("maps database account-flow error %s", (databaseMessage, expected) => {
    expect(friendlyAccountError(new Error(databaseMessage))).toContain(expected)
  })
})
