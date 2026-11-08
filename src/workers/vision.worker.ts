/// <reference lib="webworker" />

import {
  FaceLandmarker,
  FilesetResolver,
  ObjectDetector,
} from "@mediapipe/tasks-vision"

import { matrixToPose } from "@/lib/vision/pose"

type InitMessage = { type: "init" }
type DetectMessage = {
  type: "detect"
  bitmap: ImageBitmap
  timestampMs: number
  frameId: number
}
type StopMessage = { type: "stop" }
type IncomingMessage = InitMessage | DetectMessage | StopMessage

let faceLandmarker: FaceLandmarker | null = null
let objectDetector: ObjectDetector | null = null
let generation = 0
let lastObjectAt = -Infinity
let lastObjects = { personCount: 0, phoneVisible: false }
const qualityCanvas = new OffscreenCanvas(24, 24)
const qualityContext = qualityCanvas.getContext("2d", {
  willReadFrequently: true,
})
function adequateLight(bitmap: ImageBitmap) {
  if (!qualityContext || bitmap.width < 64 || bitmap.height < 64) return false
  qualityContext.drawImage(bitmap, 0, 0, 24, 24)
  const pixels = qualityContext.getImageData(0, 0, 24, 24).data
  let sum = 0
  for (let index = 0; index < pixels.length; index += 4)
    sum += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3
  const mean = sum / (pixels.length / 4)
  return mean >= 20 && mean <= 245
}

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
      const ownGeneration = ++generation
      try {
        const created = await createLandmarker()
        if (ownGeneration !== generation) {
          created.close()
          return
        }
        faceLandmarker = created
        try {
          const fileset = await FilesetResolver.forVisionTasks(
            new URL("/mediapipe/wasm", self.location.origin).toString(),
          )
          const detector = await ObjectDetector.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: new URL(
                "/mediapipe/efficientdet_lite0.tflite",
                self.location.origin,
              ).toString(),
              delegate: "CPU",
            },
            runningMode: "VIDEO",
            scoreThreshold: 0.55,
            maxResults: 6,
            categoryAllowlist: ["person", "cell phone"],
          })
          if (ownGeneration !== generation) {
            detector.close()
            return
          }
          objectDetector = detector
        } catch {
          objectDetector = null
        }
        self.postMessage({
          type: "ready",
          objectDetectorReady: Boolean(objectDetector),
        })
      } catch (error) {
        self.postMessage({
          type: "error",
          message: error instanceof Error ? error.message : "模型加载失败",
        })
      }
      return
    }

    if (event.data.type === "stop") {
      generation++
      faceLandmarker?.close()
      objectDetector?.close()
      faceLandmarker = null
      objectDetector = null
      self.postMessage({ type: "stopped" })
      return
    }

    const { bitmap, timestampMs, frameId } = event.data
    try {
      if (!faceLandmarker) throw new Error("视觉模型尚未准备好")
      if (!adequateLight(bitmap)) {
        self.postMessage({
          type: "observation",
          frameId,
          observation: {
            timestampMs,
            facePresent: false,
            yaw: null,
            pitch: null,
            valid: false,
          },
        })
        return
      }
      const result = faceLandmarker.detectForVideo(bitmap, timestampMs)
      const matrix = result.facialTransformationMatrixes[0]
      const pose = matrix
        ? matrixToPose(matrix.data)
        : { yaw: null, pitch: null }
      if (objectDetector && timestampMs - lastObjectAt >= 1_000) {
        const detections = objectDetector.detectForVideo(
          bitmap,
          timestampMs,
        ).detections
        lastObjectAt = timestampMs
        lastObjects = {
          personCount: detections.filter((item) =>
            item.categories.some(
              (category) => category.categoryName === "person",
            ),
          ).length,
          phoneVisible: detections.some((item) =>
            item.categories.some(
              (category) => category.categoryName === "cell phone",
            ),
          ),
        }
      }
      const present = result.faceLandmarks.length > 0
      self.postMessage({
        type: "observation",
        frameId,
        observation: {
          timestampMs,
          facePresent: result.faceLandmarks.length > 0,
          yaw: pose.yaw,
          pitch: pose.pitch,
          valid:
            (!present || (pose.yaw !== null && pose.pitch !== null)) &&
            lastObjects.personCount <= 1 &&
            // A visible body with an occluded/downturned face is not evidence
            // of leaving the picture (especially during paper study).
            (present ||
              (objectDetector !== null && lastObjects.personCount === 0)),
          usableForCloud: lastObjects.personCount <= 1,
          ...lastObjects,
        },
      })
    } catch {
      self.postMessage({
        type: "frame_error",
        frameId,
        message: "单帧推理失败",
      })
    } finally {
      bitmap.close()
    }
  })()
})

export {}
