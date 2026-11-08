import { describe, expect, it } from "vitest"
import {
  friendlyAccountError,
  maskEmail,
  normalizeEmail,
  validatePassword,
} from "./account"

describe("password account input", () => {
  it("normalizes email without changing passwords", () => {
    expect(normalizeEmail("  Study@Example.com ")).toBe("study@example.com")
    expect(validatePassword("  abcdEF12  ")).toBe("  abcdEF12  ")
    expect(maskEmail("study@example.com")).toBe("st•••@example.com")
  })
  it("rejects invalid email and short passwords", () => {
    for (const email of ["", "x", "x@example", "x @example.com"])
      expect(() => normalizeEmail(email)).toThrow()
    expect(() => validatePassword("1234567")).toThrow("8")
    expect(validatePassword("12345678")).toBe("12345678")
  })
  it("explains common Auth errors without exposing SQL", () => {
    expect(
      friendlyAccountError(new Error("Invalid login credentials")),
    ).toContain("邮箱或密码")
    expect(
      friendlyAccountError(new Error("User already registered")),
    ).toContain("切换到登录")
    expect(
      friendlyAccountError(new Error("Fresh password session required")),
    ).toContain("重新输入密码")
  })
})
