"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  getMyConsents,
  hasConsent,
  setMyConsent,
  type ConsentFeature,
  type UserConsents,
} from "@/lib/privacy/consents"

export function ConsentSettings({ isAnonymous }: { isAnonymous: boolean }) {
  const [consents, setConsents] = useState<UserConsents>()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let live = true
    void getMyConsents()
      .then((value) => {
        if (live) setConsents(value)
      })
      .catch(() => {
        if (live) setError("授权设置未能加载，所有可选处理保持关闭")
      })
    return () => {
      live = false
    }
  }, [])
  const change = async (feature: ConsentFeature, granted: boolean) => {
    setSaving(true)
    setError(null)
    try {
      setConsents(await setMyConsent(feature, granted))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "授权保存失败")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Card className="border-indigo-100 bg-white/90">
      <CardHeader>
        <CardTitle>可选数据处理授权</CardTitle>
        <CardDescription>
          不勾选也能制定计划、计时、手动复盘和查看事实报告。随时关闭后不再发起对应的新处理。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {(
          [
            [
              "cloud_observation",
              "云端过程观察",
              "开启摄像头前仍需为本次学习主动选择。每二十秒最多发送一组四张压缩图像给阿里云百炼，只检查约定相关行为；本应用不保存原始媒体。",
            ],
            [
              "ai_reports",
              "AI 学习报告",
              "向阿里云百炼发送本人的聚合统计、采用方案及修订摘要，生成有依据的总结与建议。绝不发送摄像头图像。",
            ],
            [
              "weekly_reports",
              "每七天自动生成 AI 学习报告",
              "仅正式账号可启用，需先授权 AI 学习报告。第七天首次生成；没有新增学习记录时跳过。关闭后不再调度。",
            ],
          ] as const
        ).map(([feature, title, description]) => (
          <div className="flex items-start gap-3" key={feature}>
            <Checkbox
              id={`consent-${feature}`}
              className="mt-1"
              checked={hasConsent(consents, feature)}
              disabled={
                !consents ||
                saving ||
                (feature === "weekly_reports" &&
                  (isAnonymous || !hasConsent(consents, "ai_reports")))
              }
              onCheckedChange={(checked) =>
                void change(feature, checked === true)
              }
            />
            <Label htmlFor={`consent-${feature}`} className="block leading-6">
              {title}
              <span className="mt-1 block text-xs leading-5 font-normal text-slate-500">
                {description}
              </span>
            </Label>
          </div>
        ))}
        <p className="text-xs leading-5 text-slate-500">
          图像只在浏览器与请求处理中短暂存在，不写入数据库、对象存储或应用日志。百炼说明会依法存储模型调用产生的数据，第三方按其服务条款处理，不能据此承诺第三方零留存。AI
          的建议不是对注意力能力或医学状态的判断。
        </p>
        {error ? (
          <div role="alert" className="text-sm text-amber-900">
            {error}
            {!consents ? (
              <Button
                variant="link"
                onClick={() =>
                  void getMyConsents()
                    .then(setConsents)
                    .then(() => setError(null))
                    .catch(() => setError("授权设置仍无法加载"))
                }
              >
                重试
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
