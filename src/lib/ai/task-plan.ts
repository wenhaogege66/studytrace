import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText, Output } from "ai"
import { z } from "zod"

import {
  taskPlanSuggestionSchema,
  type TaskPlanSuggestion,
} from "@/lib/ai/task-plan-contract"
import { observationProfileValues } from "@/lib/vision/profiles"

const generatedTaskPlanSchema = z.object({
  step1: z.string().min(1).max(100),
  step2: z.string().min(1).max(100),
  step3: z.string().min(1).max(100),
  priority: z.enum(["low", "medium", "high"]),
  estimatedMinutes: z.number().int().min(1).max(480),
  observationProfile: z.enum(observationProfileValues),
  profileReason: z.string().trim().min(1).max(100),
})

function normalizeStep(value: string) {
  return value
    .trim()
    .replace(/^\d+[.、)）]\s*/, "")
    .slice(0, 100)
}

export function validateQwenBaseURL(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("QWEN_INVALID_BASE_URL")
  }

  const trustedHost =
    url.hostname === "dashscope.aliyuncs.com" ||
    url.hostname.endsWith(".cn-beijing.maas.aliyuncs.com")
  if (
    url.protocol !== "https:" ||
    !trustedHost ||
    url.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
  )
    throw new Error("QWEN_INVALID_BASE_URL")

  return url.toString().replace(/\/$/, "")
}

export function normalizeTaskPlan(
  output: z.infer<typeof generatedTaskPlanSchema>,
): TaskPlanSuggestion {
  const steps = [output.step1, output.step2, output.step3].map(
    normalizeStep,
  ) as [string, string, string]
  if (steps.some((step) => !step) || new Set(steps).size !== steps.length)
    throw new Error("模型没有生成三个有效且不同的步骤")

  return taskPlanSuggestionSchema.parse({
    steps,
    priority: output.priority,
    estimatedMinutes: output.estimatedMinutes,
    observationProfile: output.observationProfile,
    profileReason: output.profileReason.trim().slice(0, 100),
  })
}

export async function generateTaskPlan(
  input: {
    title: string
    estimatedMinutes?: number
  },
  abortSignal?: AbortSignal,
): Promise<TaskPlanSuggestion> {
  const apiKey = process.env.QWEN_API_KEY
  const baseURL = process.env.QWEN_BASE_URL
  const modelId = process.env.QWEN_MODEL ?? "qwen3.7-flash-2026-07-15"

  if (!apiKey || !baseURL) throw new Error("QWEN_NOT_CONFIGURED")
  const trustedBaseURL = validateQwenBaseURL(baseURL)

  const qwen = createOpenAICompatible({
    name: "qwen",
    apiKey,
    baseURL: trustedBaseURL,
    supportsStructuredOutputs: true,
  })

  const { output } = await generateText({
    model: qwen.chatModel(modelId),
    output: Output.object({ schema: generatedTaskPlanSchema }),
    temperature: 0,
    maxOutputTokens: 360,
    timeout: 12_000,
    abortSignal,
    providerOptions: {
      qwen: { enable_thinking: false },
    },
    system: [
      "你是 StudyTrace 的任务规划助手，只生成可编辑的任务初稿。",
      "把任务按真实执行顺序拆成恰好三步，每步都是简短、具体、可勾选的中文动作，不重复、不虚构用户没有提到的材料。",
      "学习任务通常按明确范围、实际执行、检查总结组织；运动任务通常按准备热身、核心活动、整理记录组织。",
      "观察模式只能从白名单选择：study_screen_v1=主要面对屏幕；study_paper_v1=看书、写字、做题等低头正常；off_device_v1=运动、户外或离开电脑完成。",
      "普通的‘去运动’必须选择 off_device_v1，因为电脑摄像头无法可靠确认离开设备后的行为。",
      "不要把观察模式描述成专注、能力、健康或医学判断。",
    ].join("\n"),
    prompt: `任务标题：${input.title}\n用户当前预计时长：${input.estimatedMinutes ?? "未指定"} 分钟`,
  })

  return normalizeTaskPlan(output)
}
