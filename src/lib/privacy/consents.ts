import { z } from "zod"
import { createClient } from "@supabase/supabase-js"
import { getSupabase } from "@/lib/supabase/client"
import type { Database } from "@/types/database"

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
async function captureIdentity(expectedUserId?: string) {
  const { data, error } = await getSupabase().auth.getSession()
  const session = data.session
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (
    error ||
    !session ||
    !url ||
    !key ||
    (expectedUserId && session.user.id !== expectedUserId)
  )
    throw new Error("身份已变化，请在当前身份下重新确认授权")
  return {
    userId: session.user.id,
    client: createClient<Database>(url, key, {
      auth: {
        persistSession: false,
        storageKey: `studytrace-consents-${crypto.randomUUID()}`,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
    }),
  }
}
async function assertCurrentIdentity(userId: string) {
  const { data, error } = await getSupabase().auth.getSession()
  if (error || data.session?.user.id !== userId)
    throw new Error("身份已变化，请重新读取当前授权")
}
export async function getMyConsents(expectedUserId?: string) {
  const { client, userId } = await captureIdentity(expectedUserId)
  const { data, error } = await client.rpc("get_my_consents")
  if (error) throw new Error("授权设置暂时无法读取，请稍后重试")
  await assertCurrentIdentity(userId)
  return parseConsents(data)
}
export async function setMyConsent(
  feature: ConsentFeature,
  granted: boolean,
  expectedUserId?: string,
) {
  const { client, userId } = await captureIdentity(expectedUserId)
  const { data, error } = await client.rpc("set_my_consent", {
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
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("studytrace:consents")
    channel.postMessage({ userId, consents })
    channel.close()
  }
  await assertCurrentIdentity(userId)
  window.dispatchEvent(
    new CustomEvent("studytrace:consent-changed", { detail: consents }),
  )
  return consents
}
