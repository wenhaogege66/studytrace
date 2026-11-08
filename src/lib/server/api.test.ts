import { describe, expect, it } from "vitest"

import { ApiError, apiFailure, readBoundedJson } from "./api"

describe("bounded API payloads", () => {
  it("parses valid UTF8 input", async () => {
    expect(
      await readBoundedJson(
        new Request("https://example.com", {
          method: "POST",
          body: '{"text":"学习"}',
        }),
      ),
    ).toEqual({ text: "学习" })
  })
  it("rejects actual streamed bytes even with no content length", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: '{"long":"学习学习"}',
    })
    await expect(readBoundedJson(request, 10)).rejects.toMatchObject({
      status: 413,
    })
  })
  it("never returns internal exception details", async () => {
    const response = apiFailure(
      new Error("secret upstream detail"),
      "暂时不可用",
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "暂时不可用" })
    expect(apiFailure(new ApiError(401, "请重新进入"), "x").status).toBe(401)
  })
})
