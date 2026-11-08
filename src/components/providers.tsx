"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"

import { ActivityHeartbeat } from "@/components/auth/activity-heartbeat"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExperienceProvider } from "@/components/experience/experience-provider"

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 15_000,
          },
          mutations: { retry: 0 },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <ExperienceProvider>
          <ActivityHeartbeat />
          {children}
        </ExperienceProvider>
        <Toaster richColors position="top-center" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
