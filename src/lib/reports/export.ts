import { getSupabase } from "@/lib/supabase/client"
import type { Json } from "@/types/database"

export function csvCell(value: unknown) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
  // Spreadsheet exports must not execute user-controlled formula cells.
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export function recordsToCsv(
  tables: Record<string, Record<string, unknown>[]>,
) {
  const lines = [["记录类型", "记录ID", "内容 JSON"].map(csvCell).join(",")]
  for (const [table, records] of Object.entries(tables))
    for (const record of records)
      lines.push([table, record.id ?? "", record].map(csvCell).join(","))
  return "\uFEFF" + lines.join("\r\n")
}

export function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export async function getMyDataExport(userId: string) {
  const db = getSupabase()
  const tables = [
    "tasks",
    "study_sessions",
    "behavior_events",
    "reminder_events",
    "reviews",
    "user_settings",
    "session_segments",
    "observation_runs",
    "task_lifecycle_events",
    "task_step_events",
    "task_plan_revisions",
    "user_consents",
    "ai_reports",
  ] as const
  const result: Record<string, Record<string, unknown>[]> = {}
  for (const table of tables) {
    const rows: Record<string, unknown>[] = []
    // RLS remains authoritative; explicit owner filter prevents accidental
    // exports after an identity switch even if shared storage has changed.
    for (let offset = 0; offset <= 10_000; offset += 500) {
      const { data, error } = await db.rpc("export_my_learning_records", {
        p_table: table,
        p_expected_user_id: userId,
        p_offset: offset,
      })
      if (error) throw new Error("导出暂时失败，请稍后重试；未生成不完整文件")
      if (!Array.isArray(data)) throw new Error("导出结果格式异常，已停止")
      if (offset === 10_000 && data.length)
        throw new Error("记录超过单次导出安全上限，请按日期分批处理")
      rows.push(...(data as unknown as Record<string, unknown>[]))
      if (data.length < 500) break
    }
    result[table] = rows
  }
  const { data: session } = await db.auth.getSession()
  if (session.session?.user.id !== userId)
    throw new Error("身份已变化，本次导出已取消")
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    tables: result,
  } as unknown as Json & { tables: typeof result }
}
