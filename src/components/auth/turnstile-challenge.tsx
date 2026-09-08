"use client"

import { Turnstile } from "@marsidev/react-turnstile"
import { LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ChallengeFailure =
  "challenge" | "expired" | "load" | "timeout" | "unsupported"

const failureCopy: Record<ChallengeFailure, string> = {
  challenge: "安全校验未完成，请检查网络或浏览器拦截设置后重试。",
  expired: "安全校验已过期，请重新完成。",
  load: "安全校验长时间未加载，可能被网络或扩展拦截。",
  timeout: "安全校验等待超时，请重试。",
  unsupported: "当前浏览器不支持安全校验，请换用最新版 Chrome 或 Edge。",
}

export function TurnstileChallenge({
  className,
  onInvalidate,
  onSuccess,
  siteKey,
}: {
  className?: string
  onInvalidate?: () => void
  onSuccess: (token: string) => void | Promise<void>
  siteKey: string
}) {
  const [attempt, setAttempt] = useState(0)
  const [failure, setFailure] = useState<ChallengeFailure | null>(null)
  const [widgetLoaded, setWidgetLoaded] = useState(false)

  const fail = useCallback(
    (kind: ChallengeFailure) => {
      onInvalidate?.()
      setFailure(kind)
    },
    [onInvalidate],
  )

  useEffect(() => {
    if (failure || widgetLoaded) return

    const watchdog = window.setTimeout(() => fail("load"), 15_000)
    return () => window.clearTimeout(watchdog)
  }, [attempt, fail, failure, widgetLoaded])

  const retry = () => {
    if (failure === "load" || failure === "unsupported") {
      window.location.reload()
      return
    }

    setFailure(null)
    setWidgetLoaded(false)
    setAttempt((value) => value + 1)
  }

  return (
    <div className={cn("space-y-3", className)}>
      {failure ? (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950"
          role="alert"
        >
          <div className="flex gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">安全校验暂不可用</p>
              <p className="mt-1 text-sm leading-6">{failureCopy[failure]}</p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 min-h-11 border-amber-300 bg-white text-amber-950 hover:bg-amber-100"
                onClick={retry}
              >
                <RotateCcw />
                {failure === "load" || failure === "unsupported"
                  ? "重新加载页面"
                  : "重试安全校验"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex min-h-36 justify-center overflow-hidden">
            <Turnstile
              key={attempt}
              siteKey={siteKey}
              options={{ size: "compact" }}
              onWidgetLoad={() => setWidgetLoaded(true)}
              onSuccess={(token) => {
                setWidgetLoaded(true)
                void onSuccess(token)
              }}
              onExpire={() => fail("expired")}
              onError={() => fail("challenge")}
              onTimeout={() => fail("timeout")}
              onUnsupported={() => fail("unsupported")}
              scriptOptions={{ onError: () => fail("load") }}
            />
          </div>
          {!widgetLoaded ? (
            <p
              className="flex items-center justify-center gap-2 text-sm text-slate-600"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              正在连接安全校验
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
