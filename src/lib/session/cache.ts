import type { StudySession } from "@/lib/domain"

function isFresher(incoming: StudySession, current: StudySession) {
  if (incoming.state_version !== current.state_version)
    return incoming.state_version > current.state_version
  if (incoming.camera_version !== current.camera_version)
    return incoming.camera_version > current.camera_version
  return (
    new Date(incoming.updated_at).getTime() >=
    new Date(current.updated_at).getTime()
  )
}

export function mergeSessionSnapshot(
  current: StudySession | null | undefined,
  incoming: StudySession | null,
) {
  if (!current || !incoming || current.id !== incoming.id) return incoming
  return isFresher(incoming, current) ? incoming : current
}

export function mergeActiveQuerySnapshot(
  current: StudySession | null | undefined,
  incoming: StudySession | null,
) {
  if (!current || !incoming) return incoming
  if (current.id === incoming.id)
    return isFresher(incoming, current) ? incoming : current

  return new Date(incoming.created_at).getTime() >=
    new Date(current.created_at).getTime()
    ? incoming
    : current
}

export function mergeActiveMutationSnapshot(
  current: StudySession | null | undefined,
  incoming: StudySession,
): { value: StudySession | null; conflict: boolean } {
  const terminal =
    incoming.status === "completed" || incoming.status === "cancelled"

  if (current && current.id !== incoming.id)
    return { value: current, conflict: true }
  if (terminal) return { value: null, conflict: false }
  if (!current) return { value: incoming, conflict: false }

  return {
    value: isFresher(incoming, current) ? incoming : current,
    conflict: false,
  }
}
