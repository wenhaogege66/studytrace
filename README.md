# 学迹 StudyTrace

学迹是一款隐私优先的学习辅助 Web 产品，把「任务拆分 → 稳定计时 → 可选的本地视觉观察 → 单次复盘」连成一个真实可操作的闭环。

[在线体验](https://studytrace.vercel.app) · [产品首页](https://studytrace.vercel.app) · [公开仓库](https://github.com/wenhaogege66/studytrace)

> 当前 v0.1 不提供账号、登录或登出界面。首次进入时由 Supabase 创建匿名身份；清除浏览器数据或更换设备后，历史无法恢复。

## 为什么做学迹

普通计时器通常只留下「做了多久」，但很少回答三件更有行动价值的事：开始前目标是否足够具体、过程中发生了哪些可解释事件、下一次准备调整什么。

学迹不把视觉识别当作评价工具。它只把「未在画面」「头部方向明显变化」等最小结构化事件交给用户确认、改写或删除，不计算专注分，也不输出走神、ADHD、能力或医学判断。

## v0.1 能力

- 任务：创建、拆分步骤、优先级、预计时长、编辑和删除；可由千问生成三步可编辑初稿。
- 会话：开始、暂停、恢复、刷新恢复计时、完成步骤和手动标记；一个大任务可由多段 session 推进，每段都可结束后复盘或跳过复盘。
- 本地视觉：任务可选“屏幕学习 / 纸笔学习 / 离开设备”观察方式；MediaPipe Face Landmarker 在 Web Worker 中按需运行，摄像头画面、帧、关键点与人脸特征不上传、不保存。
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
    ├── Qwen Flash ── 仅生成可编辑任务初稿与白名单观察建议
    ├── TanStack Query ── Supabase Data API
    ├── timer reducer/ref ── 刷新恢复
    └── Camera ── 4 FPS frames ── MediaPipe Web Worker
                                      │
                                      └── 仅结构化事件 ── Supabase Postgres
```

Supabase 中的六张业务表均启用 RLS。浏览器只使用 publishable key；`anon` 没有业务表权限，匿名身份建立后使用 `authenticated` 角色，并由 `auth.uid() = user_id` 隔离数据。
公开匿名体验还设置了数据库硬上限：每个匿名身份最多保留 200 个任务、1,000 段会话、5,000 条观察事件、5,000 条提醒记录和 1,000 条复盘；超出后需先删除旧记录。任务步骤必须是 1～20 个结构化且 ID 唯一的条目。

主要路由：

- `/`：定位、问题、闭环、架构、隐私和里程碑。
- `/app`：任务工作台。
- `/app/session/[id]`：学习计时与可选视觉观察。
- `/app/review/[id]`：单次复盘与事件修正。
- `/app/settings`：数据用途、视觉/提醒阈值和数据清除。

## 本地视觉边界

观察规则是可测试的本地白名单，不是由 AI 即时生成：

- 屏幕学习：可观察持续未在画面、明显转头或低头等客观线索。
- 纸笔学习：低头是正常动作，因此禁用低头事件。
- 离开设备：适用于跑步、户外等任务，不请求摄像头，仅使用步骤、计时和复盘。

开启人脸观察时使用以下规则：

- 约 3 秒中性姿态校准，约 4 FPS 抽帧。
- 连续 5 秒无人脸，开始「未在画面」事件。
- 相对基线偏航约 25°或低头约 20°并持续 3 秒，开始方向变化事件。
- 连续恢复中性 1 秒，结束事件。
- 事件持续 15 秒后才允许提醒；同类提醒冷却 10 分钟。

数据库没有用于保存视频、图片、音频、人脸关键点、生物特征或原始帧的列。MediaPipe 模型与 WASM 放在 `public/mediapipe`，只在用户主动开启摄像头后加载。

## 数据模型与安全

- `tasks`：任务、步骤 JSON、优先级、预计时长、状态和用户确认的观察方式。
- `study_sessions`：计时状态、累计时长、摄像头与提醒状态，并快照开始当时的观察方式。
- `behavior_events`：类型、方向、来源、起止时间和用户修正。
- `reminder_events`：提醒展示与响应。
- `reviews`：完成状态、自评、未完成原因和下次调整。
- `user_settings`：授权版本、开关、阈值和隐私设置。

迁移位于 `supabase/migrations`。数据库验收脚本位于 `supabase/tests/database.test.sql`，覆盖：

- 双匿名用户 RLS 隔离与越权读取失败。
- `user_id` 所有权不可篡改。
- 同一用户最多一个运行或暂停会话。
- 已结束会话不可被延迟写入“复活”；取消本次学习会释放活动槽，但任务和步骤进度继续保留。
- 暂停、恢复、摄像头状态和计时检查点使用数据库原子操作；旧标签与迟到请求不能让状态或累计时长倒退。
- 事件起止时间不会越过所属会话的终态时间，终态后仍可确认、修正或删除事件。
- 任务步骤结构、每用户业务记录容量与 AI 调用总量均有数据库硬限制。
- 活动 session 存在时锁定任务观察方式，结束后下一段 session 才读取新策略快照。
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

如需启用 AI 任务初稿，再填写以下仅服务端可见的变量：

```dotenv
QWEN_API_KEY=your_server_only_key
QWEN_BASE_URL=https://your-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-flash-2026-07-15
```

AI 路由会先校验当前 Supabase 匿名会话，服务端重新验证三个步骤和观察模式；千问不会收到摄像头画面、视觉关键点或人脸特征。
服务端同时限制每个匿名身份 10 分钟 8 次、全站每日 200 次（UTC），入口仍由 Turnstile 抑制批量匿名身份。百炼新人免费额度并非永久免费，生产环境还应在控制台开启“免费额度用完即停”。

不要把 legacy secret、service role key、数据库密码或 Turnstile secret 写入 `NEXT_PUBLIC_*` 变量。

Supabase 端需要：

1. 按顺序应用 `supabase/migrations` 中的全部迁移。
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

Vitest 覆盖计时状态机与恢复、视觉校准与滚动窗口、事件起止、提醒冷却和数据转换。Playwright 使用本地拦截的 Supabase 契约数据，覆盖桌面完整闭环、多段 session、导航自动暂停、归档恢复、匿名入口、示例数据、摄像头拒绝、刷新恢复、事件修正与移动端公开首页；不会写入生产数据库。

数据库脚本应在隔离环境或单事务中以 `ON_ERROR_STOP` 执行。脚本自身以 `BEGIN` / `ROLLBACK` 包裹，不保留测试用户或业务数据。

## 隐私与数据生命周期

- 原始媒体始终留在浏览器内存，关闭摄像头后立即停止抽帧与 Worker。
- 服务器只接收任务、会话、结构化事件、提醒响应、复盘和设置。
- 用户可修正或硬删除单条事件，也可一键清除全部业务记录。
- 匿名身份与级联数据默认在创建 30 天后由数据库定时任务清理。
- Turnstile 只用于降低匿名入口滥用，不建立产品账号概念。

## 路线图

- v0.1：完整学习闭环、本地视觉事件、匿名安全数据层与可审计交付链。
- v0.2：为用户明确选择的“镜头内运动”按需加载 MediaPipe Pose Landmarker，先做身体入镜与运动位移等低层线索，再以实验模式探索动作计次。
- v0.3：在明确同意前提下探索数据导出与跨设备恢复，不改变本地视觉原则。

## English summary

StudyTrace is a privacy-first learning companion that connects task planning, a resumable study timer, optional on-device face-landmark observations, and a single-session review. Camera frames and landmarks never leave the browser. The server stores only user-correctable structured events, and the product deliberately avoids attention scores, diagnostic claims, and account-facing UI.

## License

No open-source license is granted at this time. The source is publicly viewable, but reuse, redistribution, and derivative works are not automatically permitted.
