export const observationProfileValues = [
  "study_screen_v1",
  "study_paper_v1",
  "off_device_v1",
] as const

export type ObservationProfile = (typeof observationProfileValues)[number]

export type VisionDetectionPolicy = {
  faceAbsent: boolean
  yaw: boolean
  pitch: boolean
}

export const DEFAULT_OBSERVATION_PROFILE: ObservationProfile = "study_screen_v1"

export const observationProfiles: Record<
  ObservationProfile,
  {
    label: string
    shortLabel: string
    description: string
    cameraEnabled: boolean
    faceAbsentMultiplier: number
    policy: VisionDetectionPolicy
  }
> = {
  study_screen_v1: {
    label: "屏幕学习",
    shortLabel: "屏幕学习",
    description: "观察是否持续离开画面，以及明显转头或低头等客观线索。",
    cameraEnabled: true,
    faceAbsentMultiplier: 1,
    policy: { faceAbsent: true, yaw: true, pitch: true },
  },
  study_paper_v1: {
    label: "纸笔或阅读",
    shortLabel: "纸笔学习",
    description: "不直接按低头角度提醒；持续离开画面仍会在更长等待后记录。",
    cameraEnabled: true,
    faceAbsentMultiplier: 2,
    policy: { faceAbsent: true, yaw: true, pitch: false },
  },
  off_device_v1: {
    label: "离开设备完成",
    shortLabel: "离设备任务",
    description: "适合运动、户外等任务；不请求摄像头，只保留计时和复盘。",
    cameraEnabled: false,
    faceAbsentMultiplier: 1,
    policy: { faceAbsent: false, yaw: false, pitch: false },
  },
}

export function parseObservationProfile(value: unknown): ObservationProfile {
  return observationProfileValues.includes(value as ObservationProfile)
    ? (value as ObservationProfile)
    : DEFAULT_OBSERVATION_PROFILE
}

export function getObservationProfile(profile: ObservationProfile) {
  return observationProfiles[profile]
}
