export function matrixToPose(data: number[]) {
  if (data.length < 16) return { yaw: 0, pitch: 0 }

  // MediaPipe returns a flattened 4×4 facial transformation matrix. The
  // rotation terms are converted to Euler angles for relative, calibrated
  // comparisons only; these values are never persisted.
  const yaw = Math.atan2(data[2], data[10]) * (180 / Math.PI)
  const pitch =
    Math.atan2(-data[6], Math.hypot(data[4], data[5])) * (180 / Math.PI)
  return { yaw, pitch }
}
