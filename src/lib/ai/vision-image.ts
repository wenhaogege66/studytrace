import { getSharp } from "next/dist/server/image-optimizer"

// Server-only decoder; do not import from the shared client contract.
export async function decodeVisionImage(image: string): Promise<{
  bytes: Uint8Array
  mediaType: "image/jpeg" | "image/png"
}> {
  try {
    const match =
      /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        image,
      )
    if (!match || match[2].length > Math.ceil((256 * 1024) / 3) * 4)
      throw new Error()
    const bytes = Buffer.from(match[2], "base64")
    if (bytes.length > 256 * 1024 || bytes.toString("base64") !== match[2])
      throw new Error()
    // libvips tolerates a missing PNG end chunk even with failOn: "warning".
    if (
      match[1] === "image/png" &&
      !bytes
        .subarray(-12)
        .equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))
    )
      throw new Error()
    const decoder = getSharp(undefined, undefined)(bytes, {
      limitInputPixels: 640 * 640,
      failOn: "warning",
    })
    const metadata = await decoder.metadata()
    if (
      `image/${metadata.format}` !== match[1] ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 640 ||
      metadata.height > 640 ||
      (metadata.pages ?? 1) !== 1
    )
      throw new Error()
    // Metadata alone accepts truncated containers; force bounded pixel decoding.
    await decoder.raw().toBuffer()
    return { bytes, mediaType: match[1] as "image/jpeg" | "image/png" }
  } catch {
    throw new Error("VISION_INVALID_IMAGE")
  }
}
