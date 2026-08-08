/// <reference lib="webworker" />

import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision"

import { matrixToPose } from "@/lib/vision/pose"

type InitMessage = { type: "init" }
type DetectMessage = {
  type: "detect"
  bitmap: ImageBitmap
  timestampMs: number
}
type StopMessage = { type: "stop" }
type IncomingMessage = InitMessage | DetectMessage | StopMessage

let faceLandmarker: FaceLandmarker | null = null

async function createLandmarker() {
  const wasmRoot = new URL("/mediapipe/wasm", self.location.origin).toString()
  const fileset = await FilesetResolver.forVisionTasks(wasmRoot)
  const options = {
    baseOptions: {
      modelAssetPath: new URL(
        "/mediapipe/face_landmarker.task",
        self.location.origin,
      ).toString(),
      delegate: "GPU" as const,
    },
    runningMode: "VIDEO" as const,
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  }

  try {
    return await FaceLandmarker.createFromOptions(fileset, options)
  } catch {
    return FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "CPU" },
    })
  }
}

self.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  void (async () => {
    if (event.data.type === "init") {
      try {
        faceLandmarker = await createLandmarker()
        self.postMessage({ type: "ready" })
      } catch (error) {
        self.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : "模型加载失败",
        })
      }
      return
    }

    if (event.data.type === "stop") {
      faceLandmarker?.close()
      faceLandmarker = null
      self.postMessage({ type: "stopped" })
      return
    }

    const { bitmap, timestampMs } = event.data
    try {
      if (!faceLandmarker) throw new Error("视觉模型尚未准备好")
      const result = faceLandmarker.detectForVideo(bitmap, timestampMs)
      const matrix = result.facialTransformationMatrixes[0]
      const pose = matrix
        ? matrixToPose(matrix.data)
        : { yaw: null, pitch: null }
      self.postMessage({
        type: "observation",
        observation: {
          timestampMs,
          facePresent: result.faceLandmarks.length > 0,
          yaw: pose.yaw,
          pitch: pose.pitch,
        },
      })
    } catch (error) {
      self.postMessage({
        type: "frame_error",
        message: error instanceof Error ? error.message : "单帧推理失败",
      })
    } finally {
      bitmap.close()
    }
  })()
})

export {}
