import { describe, expect, it } from "vitest"
import { getSharp } from "next/dist/server/image-optimizer"
import {
  invalidImages,
  jpegImage,
  pngImage,
} from "@/test/vision-image-fixtures"

import {
  readVisionJson,
  visualObservationSchema,
} from "./vision-observation-contract"
import { decodeVisionImage } from "./vision-image"

describe("cloud vision input boundary", () => {
  it("accepts unknown without inventing an observation and trims summaries", () => {
    expect(
      visualObservationSchema.parse({
        signal: "unknown",
        taskRelevance: "uncertain",
        summary: "  Cannot tell  ",
      }),
    ).toEqual({
      signal: "unknown",
      taskRelevance: "uncertain",
      summary: "Cannot tell",
    })
  })

  it.each([
    { signal: "focused", taskRelevance: "related", summary: "Reading" },
    { signal: "reading", taskRelevance: "focused", summary: "Reading" },
    { signal: "reading", taskRelevance: "related", summary: " " },
    { signal: "reading", taskRelevance: "related", summary: "x".repeat(161) },
  ])("rejects invalid model fields: %j", (value) => {
    expect(visualObservationSchema.safeParse(value).success).toBe(false)
  })

  it.each([
    { image: jpegImage, mediaType: "image/jpeg" },
    { image: pngImage, mediaType: "image/png" },
  ])("accepts genuine decodable $mediaType", async ({ image, mediaType }) => {
    expect((await decodeVisionImage(image)).mediaType).toBe(mediaType)
  })

  it.each(invalidImages)("rejects $name in memory", async ({ image }) => {
    await expect(async () => {
      await decodeVisionImage(image)
    }).rejects.toThrow("VISION_INVALID_IMAGE")
  })
  it("rejects incomplete PNG pixels even when metadata can read dimensions", async () => {
    const image = invalidImages.find(
      (fixture) => fixture.name === "PNG truncated pixel data",
    )!.image
    const bytes = Buffer.from(image.split(",")[1], "base64")
    expect(
      await getSharp(undefined, undefined)(bytes).metadata(),
    ).toMatchObject({
      width: 2,
      height: 2,
    })
    await expect(async () => {
      await decodeVisionImage(image)
    }).rejects.toThrow("VISION_INVALID_IMAGE")
  })

  it.each([
    [641, 2],
    [640, 641],
  ])("rejects %ix%i pixels before raw allocation", async (width, height) => {
    const bytes = await getSharp(
      undefined,
      undefined,
    )({
      create: { width, height, channels: 3, background: "white" },
    })
      .png()
      .toBuffer()
    await expect(async () => {
      await decodeVisionImage(
        `data:image/png;base64,${bytes.toString("base64")}`,
      )
    }).rejects.toThrow("VISION_INVALID_IMAGE")
  })

  it.each([
    "data:image/gif;base64,R0lGODlh",
    "data:image/jpeg;base64,!!!!",
    "data:image/jpeg;base64,/9j/2Q=",
    "data:image/jpeg;base64,aGVsbG8=",
    "data:image/png;base64,/9j/2Q==",
    "https://example.com/photo.jpg",
  ])("rejects MIME, base64, and magic mismatch: %s", async (image) => {
    await expect(async () => decodeVisionImage(image)).rejects.toThrow()
  })

  it("rejects more than 256 KiB decoded even with valid JPEG magic", async () => {
    const bytes = Buffer.alloc(256 * 1024 + 1)
    bytes.set([255, 216, 255])
    await expect(async () =>
      decodeVisionImage(`data:image/jpeg;base64,${bytes.toString("base64")}`),
    ).rejects.toThrow()
  })

  it("limits actual streamed bytes without Content-Length", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request("http://localhost", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit)
    await expect(readVisionJson(request)).rejects.toThrow(
      "VISION_BODY_TOO_LARGE",
    )
    expect(cancelled).toBe(true)
  })

  it("reads a small JSON body", async () => {
    await expect(
      readVisionJson(
        new Request("http://localhost", {
          method: "POST",
          body: '{"enabled":true}',
        }),
      ),
    ).resolves.toEqual({ enabled: true })
  })
})
