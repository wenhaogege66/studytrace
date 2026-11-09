# 学迹 StudyTrace

让学习目的变成可执行、可回看、可调整的行动。

StudyTrace 是一个学习执行产品：表达意图 → 选择题澄清 → 制定学习计划 → 约定观察重点 → 多次学习 → 学习复盘 → 学习报告。公开首页不展示学生、导师或真实课程身份信息。

[线上产品](https://studytrace.vercel.app) · [公开仓库](https://github.com/wenhaogege66/studytrace)

> v0.3 为分批验收版本。代码实现、自动化测试、真实摄像头验收及线上发布是不同证据；未通过人工验收的视觉能力不宣称准确率。

## 产品结构

- 学习计划：意图澄清、目的选项、完成标准、推荐方法、3–6 个执行步骤；推荐方案可编辑，首次修改提供一次 AI 点评。
- 多次学习：同一学习计划跨多次推进，暂停与结束本次学习分开；全部步骤完成后仍需确认完成计划，学习复盘可以跳过。
- 过程观察：浏览器本地检测在画面、头向与可见物体；单独授权后可使用百炼低频图像序列理解。纸笔学习允许正常低头。
- 学习报告：7／30 天事实统计、样本覆盖、规则建议；可选 AI 解读与正式账号每七天自动报告。
- 账号：匿名体验与独立邮箱密码账号。关闭邮件确认，不发送邮件、没有邮件找回，不自动升级或合并匿名数据。邮箱未核验，不可用于证明邮箱归属。
- 记录导出：本人 JSON／CSV 数据、AI 解读及可打印报告。

统一命名见 [设计规范](DESIGN.md)；数据库沿用 tasks 与 study_sessions，不因文案变化重建模型。

## 架构与权限

前端使用 Next.js 16 App Router、React 19、TypeScript、Tailwind CSS 4、Radix/shadcn 与 TanStack Query。瞬时计时、视频帧与推理状态使用 ref／Worker，不把视频放进全局状态。

后端尽量简单：

1. Supabase Auth 管身份，Postgres 存数据，RLS 按 auth.uid() 隔离本人记录。
2. 原子 RPC 管会话、确认完成、版本保存和受限数据导出，客户端不能直接绕过生命周期规则。
3. Next.js 服务端路由调用千问，校验用户、授权、学习状态与额度。
4. 每日一个 Vercel Cron 检查到期自动报告；数据库唯一键、锁和短时租约防重复，不另建队列服务。
5. 浏览器只持 publishable key。Supabase Secret、千问 Key 与 Cron Secret 只在服务端环境变量。

## 隐私与能力边界

- 不开启云端过程观察时，摄像头帧仅在浏览器本地处理。
- 云端观察默认关闭；单独同意后，默认每 20 秒发送一组 4 张压缩帧，覆盖最近约 6 秒。不持续上传完整视频，不申请麦克风。
- 关闭摄像头、暂停、页面隐藏、离开页面或撤回授权时立即停止新采样和上传；迟到结果不产生提醒。
- 应用不把原始媒体、关键点或人脸特征写入数据库、对象存储、日志或错误追踪，只保存结构化线索、覆盖和用户修正。
- 百炼官方说明会依法存储模型与应用调用产生的数据，详见[服务商隐私说明](https://help.aliyun.com/zh/model-studio/privacy-notice)。应用不承诺第三方零留存。
- AI 学习报告只接收本人聚合统计、采用方案与修订摘要，不接收摄像头画面。
- 无法可靠观察的平板／手机、低光、遮挡和模型分歧返回无法判断。不输出专注分，不判断心理状态、能力、疲劳、情绪或医学状态。
- 模拟事件明确标记，不参与真实规律统计。少于 2 分钟的碎片与未经确认的视觉事件不参与规律建议。
- 长期规律至少需要近 30 天 20 个有效片段和 10 个活跃日，且证据完整。样本不足时只总结已有记录。

## 本地运行

需要 Node.js 22+、pnpm 11、Docker 和 Supabase CLI。不要把任何真实 Secret 提交到 Git。

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
supabase start
supabase db reset
pnpm dev
```

根据本地 Supabase 输出填写 publishable URL／key。线上启用 Turnstile 时，site key 在前端，secret 在 Supabase Auth，不可混用。

AI 的规划、视觉、报告分别设置模型和开关；先轮换任何曾在会话中出现过的 Key，并在百炼控制台确认“免费额度用完即停”。模型与免费额度可能变动，配置前按[官方额度说明](https://help.aliyun.com/zh/model-studio/new-free-quota/)核验。默认不自动切换付费模型。额度或服务不可用时，手动计划、计时、本地观察、复盘和事实报告继续工作。

## 页面与接口

- /：公开介绍；/auth：独立邮箱密码账号与匿名入口。
- /app：学习计划；/app/plans/new：分阶段制定计划。
- /app/session/[id]：本次学习；/app/review/[id]：学习复盘。
- /app/insights：学习报告；/app/settings：授权、记录和账号设置。
- /api/planning/prepare：澄清题或推荐方案；/api/planning/review：一次修改点评。
- /api/observation/analyze：受限图像序列分析。
- /api/reports/generate：本人主动生成；/api/cron/reports：服务端周期调度。

## 测试与交付

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

数据库脚本位于 supabase/tests，只能运行在隔离本地库；脚本回滚测试数据，不能对生产直接执行。分别核验所有权隔离、密码注销、原子计划版本、会话状态、观察覆盖、授权撤回、报告缓存／租约／周期。

真实摄像头验收与演示分开：每种目标行为重复五次、至少四次正确记录；正常学习二十分钟错误提醒不超过两次，无法判断计入漏检分析。以实际验收记录为准，不把模型说明或模拟 E2E 当成真人效果证明。

发布按四个 PR：账号与设计基线 → 引导规划 → 过程观察 → 学习报告与交付。每个 PR 验证 Preview；最终 staged Production 验收后原地 Promote 同一构建，生产冒烟通过后再清理旧 StudyTrace 数据，不影响其他项目。

## 版本方向

v0.1 基础闭环 → v0.1.1 多次学习与确认完成 → v0.2 事实记录 → v0.3 引导规划、观察约定与 AI 解读。

全身运动识别、持续视频理解与医学判断不在本轮范围。演示将使用真实界面录制；示例历史与模拟事件必须标记。

## English summary

StudyTrace turns learning intent into editable plans, repeated study sessions, optional consent-based process observation, reflection and evidence-grounded reports. Built with Next.js and Supabase; local MediaPipe inference and optional low-frequency Qwen vision. No raw camera media is stored by this application. Anonymous trials and separate password accounts are supported.

No open-source license is granted by default. Public source visibility does not imply redistribution permission.
