import { z } from "zod"
import { getSupabase } from "@/lib/supabase/client"

export const CONSENT_VERSION = "2026-11-08.v1"
export const consentFeatures = [
  "cloud_observation",
  "ai_reports",
  "weekly_reports",
] as const
export type ConsentFeature = (typeof consentFeatures)[number]
const consentSchema = z.object({
  granted: z.boolean(),
  version: z.string(),
  granted_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  updated_at: z.string(),
})
export type ConsentRecord = z.infer<typeof consentSchema>
export type UserConsents = Partial<Record<ConsentFeature, ConsentRecord>>
const consentsSchema = z.object({
  cloud_observation: consentSchema.optional(),
  ai_reports: consentSchema.optional(),
  weekly_reports: consentSchema.optional(),
})
export function parseConsents(value: unknown): UserConsents {
  return consentsSchema.parse(value)
}
export function hasConsent(
  consents: UserConsents | undefined,
  feature: ConsentFeature,
) {
  return (
    consents?.[feature]?.granted === true &&
    consents[feature]?.version === CONSENT_VERSION
  )
}
export async function getMyConsents() {
  const { data, error } = await getSupabase().rpc("get_my_consents")
  if (error) throw new Error("授权设置暂时无法读取，请稍后重试")
  return parseConsents(data)
}
export async function setMyConsent(feature: ConsentFeature, granted: boolean) {
  const { data, error } = await getSupabase().rpc("set_my_consent", {
    p_feature: feature,
    p_granted: granted,
    p_version: CONSENT_VERSION,
  })
  if (error)
    throw new Error(
      feature === "weekly_reports"
        ? "请先启用 AI 学习报告，并使用正式账号"
        : "授权设置保存失败，请稍后重试",
    )
  const consents = parseConsents(data)
  window.dispatchEvent(
    new CustomEvent("studytrace:consent-changed", { detail: consents }),
  )
  return consents
}
