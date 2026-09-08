import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Progress } from "./progress"

describe("Progress", () => {
  it("exposes its determinate value and accessible name", () => {
    render(<Progress value={42} aria-label="任务步骤完成进度" />)

    const progress = screen.getByRole("progressbar", {
      name: "任务步骤完成进度",
    })
    expect(progress).toHaveAttribute("aria-valuenow", "42")
    expect(progress).toHaveAttribute("data-state", "loading")
  })
})
