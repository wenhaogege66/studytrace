# 邮箱密码账号与设计基线验收

日期：2026-11-08。范围：本地代码、本地隔离 Supabase 与 Playwright。此记录不代表远程配置、Preview 或 Production 已发布。

## 已实现

- 匿名体验和独立邮箱密码账号并存，最少八字符；没有邮件确认、邮件找回、匿名升级或自动合并入口。
- 新身份先在不持久化的临时 Auth 客户端验证。失败不替换当前身份；成功前暂停正在计时的本次学习，并通知各标签页停止观察。
- 身份真正变化后清空 TanStack Query 缓存及旧身份的规划草稿。密码和临时验证 Token 不进入项目自定义持久化存储。
- 注销重新验证密码，数据库同时核验五分钟内 password AMR、同一用户的真实未过期 Auth Session 与账号类型。RPC 不接收密码或用户 ID，浏览器不使用 Secret / service role。
- 通过新增迁移撤销旧 OTP、合并、旧账号删除 API 的应用权限，保留历史实现与历史数据表。
- 主导航统一为学习计划、学习报告、设置；PRODUCT.md 与 DESIGN.md 记录术语、配色、密度、状态与无障碍规范。

## 验证方法与证据

- Vitest：80/80 通过，涵盖账号输入、临时验证/安全切换、切换失败回退、暂停失败中止、密码注销、账号界面、身份生命周期及生产权限边界；网络校验不确定时保留当前身份的规划草稿，真正切换时才清理。
- 本地真实 Auth E2E：无邮件注册、不同身份读不到对方记录、错误密码不切换、退出后密码登录、密码注销（两条综合用例通过）。
- SQL：`password_account.test.sql` 校验 fresh AMR 与 live-session 双边界、匿名拒绝、他人 Session 拒绝、过期认证拒绝和本人级联删除；`account_sync.test.sql` 与 `database.test.sql` 回归通过。历史账号测试只在最终回滚的测试事务中临时恢复旧函数 grant，不影响部署权限。
- Playwright：主套件 19/19、Turnstile 失败降级 2/2、真实本地 Auth 2/2 通过，覆盖密码失败保护、独立注册、安全暂停、注销、键盘焦点和 390px 手机无横向溢出。截图位于被忽略的 `output/playwright/auth-desktop.png` 与 `auth-mobile.png`。
- TypeScript、ESLint 与 Next.js 构建通过。Impeccable 检出零反模式；现有 session-grid 背景有一项 advisory，本次未改动该执行页画布样式。

## 远程发布前配置

在目标 Supabase 的 Auth 配置中启用 Email/password 和匿名体验、关闭 Confirm email 与 Manual identity linking、密码最短长度设为八字符。生产继续使用 Turnstile；不配置 SMTP、不向 GitHub 写入密钥。仓库内 config.toml 只配置本地环境，不会自动改变云端。

没有邮箱归属验证意味着邮箱只是账号名，不能用来证明身份；没有邮件找回意味着遗忘密码后不可自行恢复。历史仅 OTP 账号若没有密码，也不能使用新密码入口，需单独决定是否保留旧数据或由维护者处理，不静默迁移或删除。

学习报告导航目标由后续报告 PR 提供；中间 PR 不应提前单独发布成最终公开版本。真实摄像头、云端视觉、周期 AI 报告、远程 advisors 与 Production 冒烟由对应后续 PR 验收。
