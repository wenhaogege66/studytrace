import { describe, expect, it } from "vitest"
import { csvCell, recordsToCsv } from "./export"

describe("safe record exports", () => {
  it("quotes delimiters and embedded line breaks without dropping content", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"')
    const csv = recordsToCsv({
      tasks: [{ id: "1", title: "复习,数学", steps: [{ title: "讲解" }] }],
    })
    expect(csv).toContain("复习,数学")
    expect(csv).toContain("讲解")
    expect(csv.startsWith("\uFEFF")).toBe(true)
  })
  it("prevents spreadsheet formula injection", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe('"\'=HYPERLINK(1)"')
    expect(csvCell(" +cmd")).toBe('"\' +cmd"')
  })
})
