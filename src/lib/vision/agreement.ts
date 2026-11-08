import { z } from "zod"

import type { ObservationProfile } from "@/lib/vision/profiles"

export const devicePolicySchema = z.enum(["allowed", "restricted", "ignored"])

export const observationAgreementSchema = z.object({
  phone: devicePolicySchema,
  tablet: devicePolicySchema,
  absenceSeconds: z.number().int().min(30).max(600).nullable(),
  screenDirection: z.boolean(),
})

export type ObservationAgreement = z.infer<typeof observationAgreementSchema>

export const DEFAULT_OBSERVATION_AGREEMENT: ObservationAgreement = {
  phone: "ignored",
  tablet: "ignored",
  absenceSeconds: 60,
  screenDirection: false,
}

export function agreementForProfile(
  profile: ObservationProfile,
): ObservationAgreement {
  return profile === "off_device_v1"
    ? { ...DEFAULT_OBSERVATION_AGREEMENT, absenceSeconds: null }
    : { ...DEFAULT_OBSERVATION_AGREEMENT }
}

export function parseObservationAgreement(
  value: unknown,
): ObservationAgreement {
  const result = observationAgreementSchema.safeParse(value)
  return result.success ? result.data : { ...DEFAULT_OBSERVATION_AGREEMENT }
}
