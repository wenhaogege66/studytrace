"use client"

import {
  Camera,
  Database,
  EyeOff,
  FlaskConical,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSettings, useSettingsMutations } from "@/hooks/use-study-data"
import type { TablesUpdate } from "@/types/database"

function SettingRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Camera
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col justify-between gap-4 py-5 sm:flex-row sm:items-center">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700">
          <Icon className="size-5" />
        </span>
        <div>
          <p className="font-medium text-slate-900">{title}</p>
          <p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">
            {description}
          </p>
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsScreen() {
  const router = useRouter()
  const settings = useSettings()
  const mutations = useSettingsMutations()
  const [cameraPermission, setCameraPermission] = useState<
    PermissionState | "unknown"
  >("unknown")

  useEffect(() => {
    if (!navigator.permissions?.query) return
    void navigator.permissions
      .query({ name: "camera" as PermissionName })
      .then((permission) => {
        setCameraPermission(permission.state)
        permission.addEventListener("change", () =>
          setCameraPermission(permission.state),
        )
      })
      .catch(() => setCameraPermission("unknown"))
  }, [])

  if (settings.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-80" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (settings.isError || !settings.data) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>设置暂时没有加载出来</CardTitle>
          <CardDescription>{settings.error?.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => void settings.refetch()}>
            <RotateCcw /> 重试
          </Button>
        </CardContent>
      </Card>
    )
  }

  const save = async (
    update: TablesUpdate<"user_settings">,
    message = "设置已保存",
  ) => {
    try {
      await mutations.update.mutateAsync(update)
      toast.success(message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "设置保存失败")
    }
  }

  const value = settings.data
  const resetThresholds = () =>
    void save(
      {
        calibration_seconds: 3,
        sample_fps: 4,
        face_absent_seconds: 5,
        direction_hold_seconds: 3,
        neutral_recovery_seconds: 1,
        reminder_delay_seconds: 15,
        reminder_cooldown_seconds: 600,
        yaw_threshold_degrees: 25,
        pitch_threshold_degrees: 20,
      },
      "已恢复默认识别阈值",
    )

  return (
    <>
      <section>
        <p className="section-kicker">Data & preferences / 数据与设置</p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
          你应该清楚每一项数据为何存在。
        </h1>
        <p className="mt-3 max-w-3xl leading-7 text-slate-600">
          这里没有账号设置。只有数据用途、可选能力、阈值与清除权。
        </p>
      </section>

      <Tabs defaultValue="privacy" className="mt-8">
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="privacy">数据与隐私</TabsTrigger>
          <TabsTrigger value="vision">视觉观察</TabsTrigger>
          <TabsTrigger value="reminders">提醒</TabsTrigger>
          <TabsTrigger value="danger">清除数据</TabsTrigger>
        </TabsList>

        <TabsContent value="privacy" className="mt-5 space-y-5">
          <Card className="border-indigo-100 bg-white/90">
            <CardHeader>
              <CardTitle>数据用途清单</CardTitle>
              <CardDescription>
                当前同意版本：{value.consent_version} ·{" "}
                {new Date(value.consented_at).toLocaleDateString("zh-CN")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {[
                {
                  icon: Database,
                  title: "保存",
                  description:
                    "任务、步骤、优先级、预计时长、会话计时、结构化事件、提醒响应和一次复盘。",
                },
                {
                  icon: EyeOff,
                  title: "绝不保存",
                  description:
                    "摄像头视频、图片、音频、人脸关键点、人脸特征和可重建画面的帧。",
                },
                {
                  icon: Sparkles,
                  title: "按需发送给 AI",
                  description:
                    "仅在你点击“AI 生成 3 步”时，将任务标题和预计时长发送给阿里云百炼；不发送摄像头、视觉事件或已有学习记录。",
                },
                {
                  icon: ShieldCheck,
                  title: "隔离方式",
                  description:
                    "匿名用户使用 authenticated 角色；每张业务表均以 auth.uid() = user_id 执行 RLS。",
                },
              ].map(({ icon, title, description }, index) => (
                <div key={title}>
                  <SettingRow
                    icon={icon}
                    title={title}
                    description={description}
                  >
                    <Badge variant={index === 1 ? "secondary" : "outline"}>
                      {index === 1
                        ? "0 条"
                        : index === 2
                          ? "仅主动点击时"
                          : "仅当前匿名会话"}
                    </Badge>
                  </SettingRow>
                  {index < 3 ? <Separator /> : null}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="border-emerald-200 bg-emerald-50/70">
            <CardContent className="flex items-start gap-3 p-5 text-sm leading-6 text-emerald-950">
              <ShieldCheck className="mt-0.5 size-5 shrink-0" />
              <p>
                匿名身份清除浏览器数据或换设备后无法恢复。匿名身份与其级联业务记录默认在创建
                30 天后由数据库定时清理。
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vision" className="mt-5 space-y-5">
          <Card className="border-indigo-100 bg-white/90">
            <CardHeader>
              <CardTitle>摄像头与实验模式</CardTitle>
              <CardDescription>
                摄像头只能在学习会话中由你主动开启。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SettingRow
                icon={Camera}
                title="摄像头始终手动开启"
                description={`浏览器权限：${cameraPermission === "granted" ? "已允许" : cameraPermission === "denied" ? "已拒绝" : cameraPermission === "prompt" ? "使用时询问" : "未知"}。StudyTrace 不会自动打开摄像头；每次学习会话都由你主动开启。`}
              >
                <Badge variant="secondary">默认关闭</Badge>
              </SettingRow>
              <Separator />
              <SettingRow
                icon={FlaskConical}
                title="技术实验模式"
                description="明确缩短阈值并允许注入模拟事件，只用于课堂展示；所有模拟事件都会标记来源。"
              >
                <Switch
                  checked={value.experiment_mode}
                  onCheckedChange={(checked) =>
                    void save(
                      { experiment_mode: checked },
                      checked ? "技术实验模式已开启" : "已回到真实识别模式",
                    )
                  }
                  aria-label="技术实验模式"
                />
              </SettingRow>
            </CardContent>
          </Card>

          <Card className="border-indigo-100 bg-white/90">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>识别阈值</CardTitle>
                  <CardDescription className="mt-1">
                    以 4 FPS
                    滚动窗口去抖。纸笔学习会自动延长无人脸阈值并忽略低头，离设备任务不会开启摄像头；实验模式会临时使用演示阈值。
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={resetThresholds}>
                  <RotateCcw /> 恢复默认
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-7">
              {[
                {
                  key: "face_absent_seconds" as const,
                  label: "无人脸持续",
                  value: value.face_absent_seconds,
                  min: 2,
                  max: 30,
                  unit: "秒",
                },
                {
                  key: "direction_hold_seconds" as const,
                  label: "方向变化持续",
                  value: value.direction_hold_seconds,
                  min: 1,
                  max: 15,
                  unit: "秒",
                },
                {
                  key: "yaw_threshold_degrees" as const,
                  label: "偏航阈值",
                  value: value.yaw_threshold_degrees,
                  min: 10,
                  max: 60,
                  unit: "°",
                },
                {
                  key: "pitch_threshold_degrees" as const,
                  label: "低头阈值",
                  value: value.pitch_threshold_degrees,
                  min: 10,
                  max: 60,
                  unit: "°",
                },
              ].map((item) => (
                <div
                  key={item.key}
                  className="grid gap-3 sm:grid-cols-[10rem_1fr_4rem] sm:items-center"
                >
                  <Label>{item.label}</Label>
                  <Slider
                    min={item.min}
                    max={item.max}
                    step={1}
                    value={[item.value]}
                    onValueCommit={([next]) => void save({ [item.key]: next })}
                    aria-label={item.label}
                  />
                  <span className="text-right font-mono text-sm text-slate-600">
                    {item.value}
                    {item.unit}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reminders" className="mt-5">
          <Card className="border-indigo-100 bg-white/90">
            <CardHeader>
              <CardTitle>低打扰提醒</CardTitle>
              <CardDescription>
                提醒只在事件持续一段时间后出现，同类提醒有冷却时间。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SettingRow
                icon={Volume2}
                title="允许轻提醒"
                description="关闭后仍会记录你允许的结构化事件，但不会弹出回到任务的提示。"
              >
                <Switch
                  checked={value.reminders_enabled}
                  onCheckedChange={(checked) =>
                    void save({ reminders_enabled: checked })
                  }
                  aria-label="允许轻提醒"
                />
              </SettingRow>
              <Separator />
              <div className="grid gap-7 py-6 sm:grid-cols-2">
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <Label>提醒延迟</Label>
                    <span className="font-mono text-sm">
                      {value.reminder_delay_seconds} 秒
                    </span>
                  </div>
                  <Slider
                    min={3}
                    max={120}
                    step={1}
                    value={[value.reminder_delay_seconds]}
                    onValueCommit={([next]) =>
                      void save({ reminder_delay_seconds: next })
                    }
                  />
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <Label>同类冷却</Label>
                    <span className="font-mono text-sm">
                      {Math.round(value.reminder_cooldown_seconds / 60)} 分钟
                    </span>
                  </div>
                  <Slider
                    min={1}
                    max={60}
                    step={1}
                    value={[Math.round(value.reminder_cooldown_seconds / 60)]}
                    onValueCommit={([next]) =>
                      void save({ reminder_cooldown_seconds: next * 60 })
                    }
                  />
                </div>
              </div>
              <p className="rounded-xl bg-indigo-50 p-4 text-sm leading-6 text-indigo-950">
                默认：事件持续 15 秒后才允许提醒，同类提醒冷却 10
                分钟。提醒不代表算法认为你“走神”。
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="mt-5">
          <Card className="border-red-200 bg-white/90">
            <CardHeader>
              <CardTitle className="text-red-700">
                永久清除全部业务数据
              </CardTitle>
              <CardDescription>
                删除任务、会话、事件、提醒、复盘、设置与临时 AI
                限流计数。匿名会话本身仍留在当前浏览器，以便继续创建新数据。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">
                这是硬删除，无法撤销。数据库函数会核验当前 auth.uid()，RLS
                同样限制只能删除自己的记录。
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" className="mt-5">
                    <Trash2 /> 清除我的全部数据
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认永久清除全部数据？</AlertDialogTitle>
                    <AlertDialogDescription>
                      所有任务、学习会话、结构化事件和复盘都会立即删除，无法恢复。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={mutations.clear.isPending}
                      onClick={() =>
                        void mutations.clear
                          .mutateAsync()
                          .then(() => {
                            toast.success("全部业务数据已清除")
                            router.push("/app")
                          })
                          .catch((error) => toast.error(error.message))
                      }
                    >
                      {mutations.clear.isPending ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}{" "}
                      永久清除
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  )
}
