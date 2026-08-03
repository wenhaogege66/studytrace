# 学迹 StudyTrace

学迹是一款隐私优先的学习辅助 Web 产品，把「任务拆分 → 稳定计时 → 可选的本地视觉观察 → 单次复盘」连成一个真实可操作的闭环。

[在线体验](https://studytrace.vercel.app) · [产品首页](https://studytrace.vercel.app) · [公开仓库](https://github.com/wenhaogege66/studytrace)

> 当前 v0.1 不提供账号、登录或登出界面。首次进入时由 Supabase 创建匿名身份；清除浏览器数据或更换设备后，历史无法恢复。

## 为什么做学迹

普通计时器通常只留下「做了多久」，但很少回答三件更有行动价值的事：开始前目标是否足够具体、过程中发生了哪些可解释事件、下一次准备调整什么。

学迹不把视觉识别当作评价工具。它只把「未在画面」「头部方向明显变化」等最小结构化事件交给用户确认、改写或删除，不计算专注分，也不输出走神、ADHD、能力或医学判断。

## v0.1 能力

- 任务：创建、拆分步骤、优先级、预计时长、编辑和删除。
- 会话：开始、暂停、恢复、刷新恢复计时、完成步骤和手动标记。
- 本地视觉：MediaPipe Face Landmarker 在 Web Worker 中按需运行；摄像头画面、帧、关键点与人脸特征不上传、不保存。
- 事件：滚动窗口去抖、低打扰提醒、来源标记、确认、修正与硬删除。
- 复盘：预计/实际时长、事件时间线、完成情况、自我感受和下次调整。
- 隐私：匿名会话、逐行权限隔离、全部数据清除、30 天匿名数据清理。
- 展示：技术实验模式可缩短阈值和注入明确标记的模拟事件。

桌面 Chrome / Edge 是完整体验目标。手机端支持首页、任务管理和手动复盘；摄像头视觉能力按浏览器兼容性尽力支持。

## 技术架构

```text
Next.js 16 App Router
├── 静态公开首页 /
└── 动态应用 /app
    ├── React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui
    ├── TanStack Query ── Supabase Data API
    ├── timer reducer/ref ── 刷新恢复
    └── Camera ── 4 FPS frames ── MediaPipe Web Worker
                                      │
                                      └── 仅结构化事件 ── Supabase Postgres
```

Supabase 中的六张业务表均启用 RLS。浏览器只使用 publishable key；`anon` 没有业务表权限，匿名身份建立后使用 `authenticated` 角色，并由 `auth.uid() = user_id` 隔离数据。

主要路由：

- `/`：定位、问题、闭环、架构、隐私和里程碑。
- `/app`：任务工作台。
- `/app/session/[id]`：学习计时与可选视觉观察。
- `/app/review/[id]`：单次复盘与事件修正。
- `/app/settings`：数据用途、视觉/提醒阈值和数据清除。

## 本地视觉边界

真实模式默认使用以下规则：

- 约 3 秒中性姿态校准，约 4 FPS 抽帧。
- 连续 5 秒无人脸，开始「未在画面」事件。
- 相对基线偏航约 25°或低头约 20°并持续 3 秒，开始方向变化事件。
- 连续恢复中性 1 秒，结束事件。
- 事件持续 15 秒后才允许提醒；同类提醒冷却 10 分钟。

数据库没有用于保存视频、图片、音频、人脸关键点、生物特征或原始帧的列。MediaPipe 模型与 WASM 放在 `public/mediapipe`，只在用户主动开启摄像头后加载。

## 数据模型与安全

- `tasks`：任务、步骤 JSON、优先级、预计时长和状态。
- `study_sessions`：计时状态、累计时长、摄像头与提醒状态。
- `behavior_events`：类型、方向、来源、起止时间和用户修正。
- `reminder_events`：提醒展示与响应。
- `reviews`：完成状态、自评、未完成原因和下次调整。
- `user_settings`：授权版本、开关、阈值和隐私设置。

迁移位于 `supabase/migrations`。数据库验收脚本位于 `supabase/tests/database.test.sql`，覆盖：

- 双匿名用户 RLS 隔离与越权读取失败。
- `user_id` 所有权不可篡改。
- 同一用户最多一个运行或暂停会话。
- 任务关联记录级联删除。
- `delete_my_data()` 只清除调用者自己的全部业务记录。
- `anon` 无业务表权限，`authenticated` 仅拥有必要 CRUD/RPC 权限。

## 本地运行

要求 Node.js 22+ 与 pnpm 11.9.0。

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

在 `.env.local` 填写三项浏览器安全配置：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
NEXT_PUBLIC_TURNSTILE_SITE_KEY=your_turnstile_site_key
```

不要把 legacy secret、service role key、数据库密码或 Turnstile secret 写入 `NEXT_PUBLIC_*` 变量。

Supabase 端需要：

1. 应用 `supabase/migrations/20260803090508_initial_schema.sql`。
2. 在 Auth 设置中开启匿名身份。
3. 配置 Cloudflare Turnstile secret，并在前端填入配套 site key。
4. 运行 Security / Performance Advisors；新库未使用索引提示是信息项，应在产生真实流量后再评估。

## 测试

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# 首次运行 E2E 前安装 Chromium
pnpm exec playwright install chromium
pnpm test:e2e
```

Vitest 覆盖计时状态机与恢复、视觉校准与滚动窗口、事件起止、提醒冷却和数据转换。Playwright 使用本地拦截的 Supabase 契约数据，覆盖桌面完整闭环、匿名入口、示例数据、摄像头拒绝、刷新恢复、事件修正与移动端公开首页；不会写入生产数据库。

数据库脚本应在隔离环境或单事务中以 `ON_ERROR_STOP` 执行。脚本自身以 `BEGIN` / `ROLLBACK` 包裹，不保留测试用户或业务数据。

## 隐私与数据生命周期

- 原始媒体始终留在浏览器内存，关闭摄像头后立即停止抽帧与 Worker。
- 服务器只接收任务、会话、结构化事件、提醒响应、复盘和设置。
- 用户可修正或硬删除单条事件，也可一键清除全部业务记录。
- 匿名身份与级联数据默认在创建 30 天后由数据库定时任务清理。
- Turnstile 只用于降低匿名入口滥用，不建立产品账号概念。

## 路线图

- v0.1：完整学习闭环、本地视觉事件、匿名安全数据层与可审计交付链。
- v0.2：更多手动观察维度、复盘趋势和可解释校准。
- v0.3：在明确同意前提下探索数据导出与跨设备恢复，不改变本地视觉原则。

## English summary

StudyTrace is a privacy-first learning companion that connects task planning, a resumable study timer, optional on-device face-landmark observations, and a single-session review. Camera frames and landmarks never leave the browser. The server stores only user-correctable structured events, and the product deliberately avoids attention scores, diagnostic claims, and account-facing UI.

## License

No open-source license is granted at this time. The source is publicly viewable, but reuse, redistribution, and derivative works are not automatically permitted.
