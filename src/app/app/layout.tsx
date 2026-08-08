import type { ReactNode } from "react"

import { ExperienceGate } from "@/components/experience/experience-gate"
import { Providers } from "@/components/providers"

export const dynamic = "force-dynamic"

export default function StudyAppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <ExperienceGate>{children}</ExperienceGate>
    </Providers>
  )
}
