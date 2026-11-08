export const MIN_PASSWORD_LENGTH = 8

export function normalizeEmail(value: string) {
  const email = value.trim().toLocaleLowerCase("en-US")
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("请输入有效的邮箱地址")
  }
  return email
}

export function validatePassword(value: string) {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error("密码至少需要 8 个字符")
  }
  return value
}

export function maskEmail(value: string) {
  const [local, domain] = value.split("@")
  return domain ? `${local.slice(0, 2)}•••@${domain}` : "邮箱账号"
}

export function friendlyAccountError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "暂时无法完成，请重试。"
  const lower = message.toLocaleLowerCase("en-US")
  if (lower.includes("invalid login credentials"))
    return "邮箱或密码不正确，请检查后重试。"
  if (lower.includes("already registered"))
    return "这个邮箱已注册，请切换到登录。"
  if (lower.includes("email not confirmed"))
    return "当前环境仍要求邮箱确认，请联系维护者关闭邮箱确认后重试。"
  if (lower.includes("captcha") || lower.includes("challenge"))
    return "安全校验未通过，请重新完成后重试。"
  if (lower.includes("rate limit") || lower.includes("too many"))
    return "尝试过于频繁，请稍后再试。"
  if (lower.includes("fetch") || lower.includes("network"))
    return "网络连接失败，请稍后重试。若操作已提交，请刷新核对当前状态。"
  if (lower.includes("fresh password"))
    return "验证已过期，请重新输入密码后再删除账号。"
  return message
}

export function clearRetiredAccountFlowStorage() {
  if (typeof window === "undefined") return
  try {
    for (const storage of [window.sessionStorage, window.localStorage]) {
      if (!storage) continue
      for (const key of [
        "studytrace.pending-account-flow.v1",
        "studytrace.pending-account-merge-recovery.v1",
        "studytrace.pending-account-merge-handoff.v1",
        "studytrace.account-merge-handoff.v1",
        "studytrace.pending-account-merge-durable.v1",
        "studytrace.pending-account-merge-durable.v2",
      ])
        storage.removeItem(key)
    }
  } catch {
    // Browsers may disable storage. Old flow cleanup must not block login.
  }
}
