import type { VisualObservation } from "@/lib/ai/vision-observation-contract"

const signals: Record<VisualObservation["signal"], string> = {
  reading: "可能在阅读",
  writing: "可能在书写",
  device_interaction: "可能在操作设备",
  looking_away: "视线可能偏离",
  absent: "画面中未见人",
  unknown: "无法判断",
}
const relevance: Record<VisualObservation["taskRelevance"], string> = {
  related: "可能相关",
  unrelated: "可能无关",
  uncertain: "不确定",
}

export function CloudObservationSummary({
  observation,
}: {
  observation: VisualObservation | null | undefined
}) {
  return (
    <div className="mt-1 space-y-1 text-xs text-slate-500">
      {observation ? (
        <>
          <p>
            信号：{signals[observation.signal]} · 任务关联：
            {relevance[observation.taskRelevance]}
          </p>
          <p>{observation.summary}</p>
        </>
      ) : null}
      <p>单帧线索，可能不准确；不推断持续时间或专注程度。</p>
    </div>
  )
}
