"use client"

import { Download, LoaderCircle, Printer } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { useExperience } from "@/components/experience/experience-provider"
import { Button } from "@/components/ui/button"
import {
  downloadFile,
  getMyDataExport,
  recordsToCsv,
} from "@/lib/reports/export"

export function ReportExport() {
  const { user } = useExperience()
  const [format, setFormat] = useState<"json" | "csv" | null>(null)
  async function exportData(next: "json" | "csv") {
    if (!user || format) return
    setFormat(next)
    try {
      const result = await getMyDataExport(user.id)
      downloadFile(
        `studytrace-records-${new Date().toISOString().slice(0, 10)}.${next}`,
        next === "json"
          ? JSON.stringify(result, null, 2)
          : recordsToCsv(result.tables),
        next === "json" ? "application/json" : "text/csv;charset=utf-8",
      )
      toast.success("学习记录已导出")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败")
    } finally {
      setFormat(null)
    }
  }
  return (
    <div className="flex flex-wrap gap-2 print:hidden" aria-label="报告导出">
      <Button
        variant="outline"
        size="sm"
        disabled={Boolean(format)}
        onClick={() => void exportData("json")}
      >
        {format === "json" ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <Download />
        )}
        JSON 记录
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={Boolean(format)}
        onClick={() => void exportData("csv")}
      >
        {format === "csv" ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <Download />
        )}
        CSV 记录
      </Button>
      <Button variant="outline" size="sm" onClick={() => window.print()}>
        <Printer />
        打印报告
      </Button>
    </div>
  )
}
