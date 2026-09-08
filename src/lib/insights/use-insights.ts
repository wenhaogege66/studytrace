"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { useExperience } from "@/components/experience/experience-provider"

import type { InsightWindow } from "./insights"
import {
  getMyInsights,
  updateMyInsightsPreferences,
} from "./insights-repository"

export const insightKeys = {
  all: (userId: string) => ["insights", userId] as const,
  report: (userId: string, days: InsightWindow) =>
    ["insights", userId, days] as const,
}

function useUserId() {
  const { user } = useExperience()
  if (!user) throw new Error("Anonymous experience is not ready")
  return user.id
}

export function useInsights(days: InsightWindow) {
  const userId = useUserId()
  return useQuery({
    queryKey: insightKeys.report(userId, days),
    queryFn: () => getMyInsights(days),
  })
}

export function useInsightsPreferencesMutation() {
  const userId = useUserId()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateMyInsightsPreferences,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: insightKeys.all(userId) }),
  })
}
