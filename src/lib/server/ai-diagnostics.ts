type AiOperation = "planning.prepare" | "planning.review"

/** Classify failures without emitting prompts, responses, media or credentials. */
export function aiFailureMetadata(error: unknown) {
  const seen = new Set<object>()
  const hints: string[] = []
  let status: number | null = null
  let current = error
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) break
    seen.add(current)
    const item = current as Record<string, unknown>
    if (
      status === null &&
      typeof item.statusCode === "number" &&
      Number.isInteger(item.statusCode) &&
      item.statusCode >= 100 &&
      item.statusCode <= 599
    )
      status = item.statusCode
    for (const key of ["name", "code", "message", "responseBody"])
      if (typeof item[key] === "string")
        hints.push((item[key] as string).slice(0, 2048))
    current = item.cause
  }
  const hint = hints.join(" ")
  const category =
    status === 401 ||
    status === 403 ||
    /InvalidApiKey|invalid.api.key/i.test(hint)
      ? "credentials_or_access"
      : status === 429 ||
          /quota|arrearage|overdue|insufficient.balance/i.test(hint)
        ? "quota"
        : /json.schema|response_format|structured.output/i.test(hint)
          ? "structured_output"
          : /enable_thinking|thinking.budget/i.test(hint)
            ? "model_parameters"
            : /model.*(not.found|not.exist|not.support)|ModelNotFound/i.test(
                  hint,
                )
              ? "model_unavailable"
              : /NOT_CONFIGURED|DISABLED|INVALID_BASE_URL/.test(hint)
                ? "configuration"
                : /timeout|abort/i.test(hint)
                  ? "timeout_or_abort"
                  : /fetch.failed|ECONN|ENOTFOUND|network|socket/i.test(hint)
                    ? "network"
                    : /validation|NoObjectGenerated|NoOutputGenerated|parse/i.test(
                          hint,
                        )
                      ? "output_validation"
                      : status === 400
                        ? "invalid_parameter"
                        : "unknown"
  return { category, status }
}

export function logAiFailure(operation: AiOperation, error: unknown) {
  console.warn("studytrace.ai_failure", {
    operation,
    ...aiFailureMetadata(error),
  })
}
