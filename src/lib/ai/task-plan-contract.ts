import { z } from "zod"

import { observationProfileValues } from "@/lib/vision/profiles"

export const taskPlanRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  estimatedMinutes: z.number().int().min(1).max(480).optional(),
})

export const taskPlanSuggestionSchema = z.object({
  steps: z.tuple([
    z.string().trim().min(1).max(100),
    z.string().trim().min(1).max(100),
    z.string().trim().min(1).max(100),
  ]),
  priority: z.enum(["low", "medium", "high"]),
  estimatedMinutes: z.number().int().min(1).max(480),
  observationProfile: z.enum(observationProfileValues),
  profileReason: z.string().trim().min(1).max(100),
})

export type TaskPlanSuggestion = z.infer<typeof taskPlanSuggestionSchema>
