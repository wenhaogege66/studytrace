import { describe, expect, it } from "vitest"
import {
  CONSENT_VERSION,
  hasConsent,
  parseConsents,
} from "@/lib/privacy/consents"
describe("separate, versioned optional consents", () => {
  it("defaults missing, revoked and stale grants to off", () => {
    expect(hasConsent(undefined, "ai_reports")).toBe(false)
    const data = {
      cloud_observation: {
        granted: true,
        version: CONSENT_VERSION,
        granted_at: new Date().toISOString(),
        revoked_at: null,
        updated_at: new Date().toISOString(),
      },
    }
    expect(hasConsent(parseConsents(data), "cloud_observation")).toBe(true)
    expect(hasConsent(parseConsents(data), "ai_reports")).toBe(false)
    expect(
      hasConsent(
        {
          ...data,
          cloud_observation: { ...data.cloud_observation, version: "old" },
        },
        "cloud_observation",
      ),
    ).toBe(false)
  })
})
