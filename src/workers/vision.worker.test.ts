import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  face: vi.fn(),
  objects: vi.fn(),
  createFace: vi.fn(),
  createObjects: vi.fn(),
  closeFace: vi.fn(),
  closeObjects: vi.fn(),
}))
vi.mock("@mediapipe/tasks-vision", () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  FaceLandmarker: { createFromOptions: mocks.createFace },
  ObjectDetector: { createFromOptions: mocks.createObjects },
}))
describe("worker safety and object signals", () => {
  let handler: (event: MessageEvent) => void
  let post: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    post = vi.fn()
    mocks.face.mockReturnValue({
      faceLandmarks: [[]],
      facialTransformationMatrixes: [
        { data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      ],
    })
    mocks.objects.mockReturnValue({
      detections: [
        { categories: [{ categoryName: "person" }] },
        { categories: [{ categoryName: "cell phone" }] },
      ],
    })
    mocks.createFace.mockResolvedValue({
      detectForVideo: mocks.face,
      close: mocks.closeFace,
    })
    mocks.createObjects.mockResolvedValue({
      detectForVideo: mocks.objects,
      close: mocks.closeObjects,
    })
    vi.stubGlobal("self", {
      location: { origin: "http://localhost" },
      postMessage: post,
      addEventListener: (
        _type: string,
        listener: (event: MessageEvent) => void,
      ) => {
        handler = listener
      },
    })
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: () => ({
              data: new Uint8ClampedArray(24 * 24 * 4).fill(100),
            }),
          }
        }
      },
    )
    await import("@/workers/vision.worker")
    handler({ data: { type: "init" } } as MessageEvent)
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ready" }),
      ),
    )
  })
  afterEach(() => vi.unstubAllGlobals())
  function detect() {
    const bitmap = { width: 640, height: 480, close: vi.fn() }
    handler({
      data: { type: "detect", frameId: 1, timestampMs: 1000, bitmap },
    } as MessageEvent)
    return bitmap
  }
  it("uses self-hosted auxiliary phone/person model and closes transferred bitmaps", () => {
    const bitmap = detect()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(mocks.createObjects).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        baseOptions: expect.objectContaining({
          modelAssetPath:
            "http://localhost/mediapipe/efficientdet_lite0.tflite",
        }),
        categoryAllowlist: ["person", "cell phone"],
      }),
    )
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "observation",
        frameId: 1,
        observation: expect.objectContaining({
          valid: true,
          phoneVisible: true,
          personCount: 1,
        }),
      }),
    )
  })
  it("closes bitmap on inference failure and returns a bounded frame error", () => {
    mocks.face.mockImplementation(() => {
      throw new Error("internalmodeldetail")
    })
    const bitmap = detect()
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect(post).toHaveBeenLastCalledWith({
      type: "frame_error",
      frameId: 1,
      message: "单帧推理失败",
    })
  })
  it("does not turn an invalid matrix into neutral posture", () => {
    mocks.face.mockReturnValue({
      faceLandmarks: [[]],
      facialTransformationMatrixes: [{ data: [1, 2] }],
    })
    detect()
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          valid: false,
          yaw: null,
          pitch: null,
        }),
      }),
    )
  })
  it("does not call a visible person absent just because their face is occluded", () => {
    mocks.face.mockReturnValue({
      faceLandmarks: [],
      facialTransformationMatrixes: [],
    })
    detect()
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          valid: false,
          facePresent: false,
          personCount: 1,
        }),
      }),
    )
  })
  it("unknowns multi-person frames and releases both models on stop", () => {
    mocks.objects.mockReturnValue({
      detections: [
        { categories: [{ categoryName: "person" }] },
        { categories: [{ categoryName: "person" }] },
      ],
    })
    detect()
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ valid: false }),
      }),
    )
    handler({ data: { type: "stop" } } as MessageEvent)
    expect(mocks.closeFace).toHaveBeenCalledOnce()
    expect(mocks.closeObjects).toHaveBeenCalledOnce()
  })
  it("does not infer absence when the auxiliary person model is unavailable", async () => {
    handler({ data: { type: "stop" } } as MessageEvent)
    mocks.createObjects.mockRejectedValueOnce(new Error("model-unavailable"))
    handler({ data: { type: "init" } } as MessageEvent)
    await vi.waitFor(() =>
      expect(post).toHaveBeenLastCalledWith({
        type: "ready",
        objectDetectorReady: false,
      }),
    )
    mocks.face.mockReturnValue({
      faceLandmarks: [],
      facialTransformationMatrixes: [],
    })
    detect()
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          facePresent: false,
          valid: false,
          usableForCloud: true,
        }),
      }),
    )
  })
})
