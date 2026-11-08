"use client"

import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { studyKeys } from "@/hooks/use-study-data"
import { mapSession, type StudySession } from "@/lib/domain"
import { getSupabase } from "@/lib/supabase/client"

export function LearningContextForm({ session }: { session: StudySession }) {
  const [minutes, setMinutes] = useState(session.target_minutes || 25)
  const [energy, setEnergy] = useState(session.energy_before || "")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const queryClient = useQueryClient()
  const ended = session.status === "completed" || session.status === "cancelled"
  const save = async () => {
    setBusy(true)
    setMessage("")
    const { data, error } = await getSupabase().rpc(
      "update_session_learning_context",
      {
        p_session_id: session.id,
        p_target_minutes: minutes,
        p_energy_before: energy || null,
      },
    )
    if (error || !data) setMessage("暂时无法保存，请稍后再试")
    else {
      const updated = mapSession(data)
      queryClient.setQueryData(
        studyKeys.session(session.user_id, session.id),
        updated,
      )
      void queryClient.invalidateQueries({
        queryKey: studyKeys.activeSession(session.user_id),
      })
      setMessage("本次学习安排已保存")
    }
    setBusy(false)
  }
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-slate-700">
        本次安排 · {session.target_minutes || 25} 分钟
        {session.plan_revision_id ? " · 已关联采用方案" : ""}
      </summary>
      <fieldset
        disabled={busy || ended}
        className="mt-3 grid gap-3 sm:grid-cols-[7rem_1fr_auto]"
      >
        <div className="space-y-2">
          <Label htmlFor="learning-target">目标分钟</Label>
          <Input
            id="learning-target"
            type="number"
            min={1}
            max={180}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="energy-before">开始时的主观精力（可选）</Label>
          <select
            id="energy-before"
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
            value={energy}
            onChange={(event) => setEnergy(event.target.value)}
          >
            <option value="">不记录</option>
            <option value="low">精力偏低</option>
            <option value="steady">比较平稳</option>
            <option value="high">精力充足</option>
          </select>
        </div>
        <Button
          className="self-end"
          variant="outline"
          disabled={!Number.isInteger(minutes) || minutes < 1 || minutes > 180}
          onClick={() => void save()}
        >
          保存本次安排
        </Button>
      </fieldset>
      <p role="status" className="mt-2 text-xs text-slate-500">
        {message || "这是主观记录，不来自摄像头或模型推断。"}
      </p>
    </details>
  )
}
