import { asSchema } from "ai"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { qwenStructuredSchema } from "@/lib/ai/qwen-schema"
import {
  learningPlanSchema,
  planningReviewSchema,
} from "@/lib/planning/contract"
import { manualLearningPlan } from "@/lib/planning/manual"

describe("Qwen structured-output schema compatibility", () => {
  it("removes record propertyNames at nested schema locations without mutating Zod", async () => {
    const record = z.record(z.string().max(4), z.string().max(8))
    const schema = z.object({
      context: record,
      nested: z.array(z.object({ choice: z.union([record, z.null()]) })),
    })
    const original = await asSchema(schema).jsonSchema
    const before = structuredClone(original)
    expect(JSON.stringify(original)).toContain("propertyNames")
    const adapted = await qwenStructuredSchema(schema).jsonSchema
    expect(JSON.stringify(adapted)).not.toContain("propertyNames")
    expect(adapted).toEqual(
      JSON.parse(
        JSON.stringify(original, (key, value) =>
          key === "propertyNames" ? undefined : value,
        ),
      ),
    )
    expect(original).toEqual(before)
    expect(await asSchema(schema).jsonSchema).toEqual(before)
    expect(adapted).toMatchObject({
      type: "object",
      required: ["context", "nested"],
      additionalProperties: false,
      properties: {
        context: { type: "object", additionalProperties: { maxLength: 8 } },
        nested: { type: "array", items: { type: "object" } },
      },
    })
  })

  it("preserves same-named business fields and literal metadata", async () => {
    const schema = z
      .object({
        propertyNames: z.string().min(1).max(20),
        additionalItems: z.boolean(),
        payload: z
          .object({ propertyNames: z.string(), additionalItems: z.boolean() })
          .default({
            propertyNames: "literal default",
            additionalItems: false,
          }),
        context: z.record(z.string().max(4), z.string()),
      })
      .meta({
        examples: [
          {
            propertyNames: { propertyNames: "literal example" },
            additionalItems: false,
          },
        ],
      })
    const adapted = await qwenStructuredSchema(schema).jsonSchema
    expect(adapted).toMatchObject({
      properties: {
        propertyNames: { type: "string", minLength: 1, maxLength: 20 },
        additionalItems: { type: "boolean" },
        payload: {
          default: { propertyNames: "literal default", additionalItems: false },
          properties: {
            propertyNames: { type: "string" },
            additionalItems: { type: "boolean" },
          },
        },
      },
      examples: [
        {
          propertyNames: { propertyNames: "literal example" },
          additionalItems: false,
        },
      ],
    })
    expect(adapted.properties?.context).not.toHaveProperty("propertyNames")
  })

  it("removes the unsupported tuple keyword while retaining its exact items and length constraints", async () => {
    const schema = learningPlanSchema.shape.completionCriteria
    const original = await asSchema(schema).jsonSchema
    expect(original).toMatchObject({
      type: "array",
      items: expect.any(Array),
      additionalItems: false,
      minItems: 3,
      maxItems: 3,
    })
    const adapted = qwenStructuredSchema(schema)
    const wire = await adapted.jsonSchema
    expect(wire).toEqual(
      Object.fromEntries(
        Object.entries(original).filter(([key]) => key !== "additionalItems"),
      ),
    )
    expect(wire.items).toHaveLength(3)
    expect(original).toHaveProperty("additionalItems", false)
    await expect(
      adapted.validate!(["完成步骤", "能解释", "做一次自测"]),
    ).resolves.toMatchObject({ success: true })
    await expect(
      adapted.validate!(["完成步骤", "能解释"]),
    ).resolves.toMatchObject({ success: false })
    await expect(
      adapted.validate!(["完成步骤", "能解释", "做一次自测", "多出一项"]),
    ).resolves.toMatchObject({ success: false })
    await expect(
      adapted.validate!(["完成步骤", "能解释", 3]),
    ).resolves.toMatchObject({ success: false })
  })

  it("keeps key-length and value-length validation after adapting the provider schema", async () => {
    const adapted = qwenStructuredSchema(
      z.record(z.string().max(4), z.string().max(8)),
    )
    await expect(adapted.validate!({ unit: "algebra" })).resolves.toEqual({
      success: true,
      value: { unit: "algebra" },
    })
    await expect(
      adapted.validate!({ toolong: "valid" }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.any(Error),
    })
    await expect(
      adapted.validate!({ unit: "far too long" }),
    ).resolves.toMatchObject({
      success: false,
    })
  })

  it("preserves async business refinements and validated output normalization", async () => {
    const adapted = qwenStructuredSchema(
      z
        .object({ purpose: z.string().trim().min(1) })
        .refine(async (value) => value.purpose !== "rejected"),
    )
    await expect(
      adapted.validate!({ purpose: "  practise  " }),
    ).resolves.toEqual({
      success: true,
      value: { purpose: "practise" },
    })
    await expect(
      adapted.validate!({ purpose: "rejected" }),
    ).resolves.toMatchObject({
      success: false,
    })
  })

  it("keeps all learning-plan and review business validators intact", async () => {
    const plan = manualLearningPlan("复习五道数学错题")
    const invalidPlan = { ...plan, context: { ["x".repeat(41)]: "unit" } }
    const adaptedPlan = qwenStructuredSchema(learningPlanSchema)
    const adaptedReview = qwenStructuredSchema(planningReviewSchema)
    expect(JSON.stringify(await adaptedPlan.jsonSchema)).not.toContain(
      "propertyNames",
    )
    expect(JSON.stringify(await adaptedReview.jsonSchema)).not.toContain(
      "propertyNames",
    )
    await expect(adaptedPlan.validate!(plan)).resolves.toMatchObject({
      success: true,
    })
    await expect(adaptedPlan.validate!(invalidPlan)).resolves.toMatchObject({
      success: false,
    })
    await expect(
      adaptedPlan.validate!({ ...plan, sessionMinutes: 181 }),
    ).resolves.toMatchObject({ success: false })
    await expect(
      adaptedReview.validate!({
        comment: "建议",
        reason: "",
        suggestion: invalidPlan,
      }),
    ).resolves.toMatchObject({ success: false })
  })
})
