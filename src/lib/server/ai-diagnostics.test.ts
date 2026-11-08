import { describe, expect, it, vi } from "vitest"

import { aiFailureMetadata, logAiFailure } from "./ai-diagnostics"

describe("privacy-safe AI diagnostics", () => {
  it("finds provider failures through bounded causes", () => {
    expect(
      aiFailureMetadata({
        name: "RetryError",
        cause: {
          statusCode: 400,
          responseBody:
            '{"error":{"message":"invalid response_format json_schema"}}',
        },
      }),
    ).toEqual({ category: "structured_output", status: 400 })
    expect(aiFailureMetadata({ statusCode: 401 })).toEqual({
      category: "credentials_or_access",
      status: 401,
    })
    expect(aiFailureMetadata({ message: "fetch failed" })).toEqual({
      category: "network",
      status: null,
    })
  })

  it("logs only static classifications, never error contents", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const secret = "PRIVATE_PROMPT_OR_IMAGE_OR_KEY"
    try {
      logAiFailure("planning.prepare", {
        statusCode: 429,
        message: secret,
        responseBody: secret,
        requestBodyValues: { image: secret },
      })
      expect(warn).toHaveBeenCalledWith("studytrace.ai_failure", {
        operation: "planning.prepare",
        category: "quota",
        status: 429,
      })
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    } finally {
      warn.mockRestore()
    }
  })

  it("terminates on cyclic errors and ignores invalid HTTP statuses", () => {
    const error: Record<string, unknown> = {
      statusCode: 999,
      message: "unknown",
    }
    error.cause = error
    expect(aiFailureMetadata(error)).toEqual({
      category: "unknown",
      status: null,
    })
  })

  it("reports only allowlisted schema signals, never provider text or values", () => {
    const metadata = aiFailureMetadata({
      statusCode: 400,
      responseBody:
        "Invalid response_format: root schema type must be object; oneOf unsupported. PRIVATE_PROMPT_OR_KEY",
    })
    expect(metadata).toEqual({
      category: "structured_output",
      status: 400,
      schemaSignals: ["root", "object", "oneOf", "unsupported"],
    })
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE_PROMPT_OR_KEY")
  })
})
