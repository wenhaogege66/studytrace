import { asSchema, jsonSchema, type Schema } from "ai"
import type { z } from "zod"

type ProviderJsonSchema = Awaited<Schema<unknown>["jsonSchema"]>

const schemaMaps = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]
const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"]
const childSchemas = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Only schema keywords are visited; property names and literal data stay intact. */
function withoutUnsupportedKeywords(
  schema: ProviderJsonSchema,
): ProviderJsonSchema {
  const result = structuredClone(schema)
  const visit = (value: unknown) => {
    if (!isObject(value)) return
    delete value.propertyNames
    delete value.additionalItems
    for (const key of schemaMaps) {
      const children = value[key]
      if (isObject(children)) Object.values(children).forEach(visit)
    }
    for (const key of schemaArrays) {
      const children = value[key]
      if (Array.isArray(children)) children.forEach(visit)
    }
    for (const key of childSchemas) {
      const child = value[key]
      if (Array.isArray(child)) child.forEach(visit)
      else visit(child)
    }
    // Draft-07 allows either schema dependencies or property-name arrays.
    if (isObject(value.dependencies))
      Object.values(value.dependencies).forEach(visit)
  }
  visit(result)
  const rootUnions = [result.oneOf, result.anyOf].filter(
    (branches) => branches !== undefined,
  )
  if (
    !Object.hasOwn(result, "type") &&
    rootUnions.length > 0 &&
    rootUnions.every(
      (branches) =>
        Array.isArray(branches) &&
        branches.length > 0 &&
        branches.every(
          (branch) => isObject(branch) && branch.type === "object",
        ),
    )
  )
    result.type = "object"
  return result
}

/**
 * Qwen strict output rejects propertyNames and additionalItems.
 * https://help.aliyun.com/zh/model-studio/qwen-structured-output
 * Adapt only the provider-facing schema. The original Zod validator still checks
 * every constraint, including record-key limits and custom business refinements.
 * Object-only root unions receive their already-implied object type explicitly.
 */
export function qwenStructuredSchema<T>(schema: z.ZodType<T>): Schema<T> {
  const original = asSchema<T>(schema)
  return jsonSchema<T>(
    async () => withoutUnsupportedKeywords(await original.jsonSchema),
    {
      validate: async (value) => {
        const result = await schema.safeParseAsync(value)
        return result.success
          ? { success: true, value: result.data }
          : { success: false, error: result.error }
      },
    },
  )
}
