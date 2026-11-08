"use client"

import { useQuery } from "@tanstack/react-query"

import { useExperience } from "@/components/experience/experience-provider"
import { learningPlanSchema } from "@/lib/planning/contract"
import { listPlanRevisions } from "@/lib/planning/repository"

const kindLabels: Record<string, string> = {
  ai_initial: "初始推荐",
  user_edit: "用户调整",
  ai_review: "一次修改点评",
  adopted: "实际采用",
  manual: "手动方案",
}

export function PlanHistory({ taskId }: { taskId: string }) {
  const { user } = useExperience()
  const revisions = useQuery({
    queryKey: ["plan-revisions", user?.id, taskId],
    queryFn: () => listPlanRevisions(user!.id, taskId),
    enabled: !!user,
  })
  return (
    <section className="mt-5 border-t border-slate-100 pt-4">
      <h3 className="text-sm font-semibold text-slate-900">方案与调整记录</h3>
      {revisions.isPending ? (
        <p className="mt-2 text-xs text-slate-500" role="status">
          正在读取…
        </p>
      ) : revisions.isError ? (
        <p className="mt-2 text-xs text-amber-800">{revisions.error.message}</p>
      ) : !revisions.data.length ? (
        <p className="mt-2 text-xs text-slate-500">
          此计划创建于版本记录启用前，下次调整时开始保留。
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {revisions.data.map((revision) => {
            const plan = learningPlanSchema.safeParse(revision.snapshot)
            return (
              <li key={revision.id}>
                <details className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <summary className="min-h-8 cursor-pointer text-sm text-slate-700">
                    <span className="font-medium">
                      {kindLabels[revision.kind] || "方案记录"}
                    </span>
                    <span className="ml-2 text-xs text-slate-500">
                      v{revision.ordinal} ·{" "}
                      {new Date(revision.created_at).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </summary>
                  <div className="space-y-2 border-t border-slate-100 pt-3 pb-1 text-xs leading-6 text-slate-600">
                    {plan.success ? (
                      <>
                        <p>{plan.data.method}</p>
                        <p>完成标准：{plan.data.selectedCriterion}</p>
                        <p>
                          整个计划 {plan.data.estimatedMinutes} 分钟 · 本次建议{" "}
                          {plan.data.sessionMinutes} 分钟
                        </p>
                        <ol>
                          {plan.data.steps.map((step, index) => (
                            <li key={step.id}>
                              {index + 1}. {step.title}
                              {step.completed ? "（当时已完成）" : ""}
                            </li>
                          ))}
                        </ol>
                      </>
                    ) : null}
                    {revision.comment ? (
                      <p className="whitespace-pre-wrap">{revision.comment}</p>
                    ) : null}
                  </div>
                </details>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
