# v0.3 隔离数据库验收

日期：2026-11-08。最后一轮结束于 09:35 UTC（北京时间 17:35）。

结论：九个 SQL 套件全部通过，均使用 `ON_ERROR_STOP=1`，进程退出码为 0。修正了一处并发测试的假通过问题后，重新运行全部九个套件；最后一轮无错误或未消费异步查询的 NOTICE。

## 环境与范围

- 仅使用 `127.0.0.1:54322` 的隔离本地 Supabase；本次验收没有重置数据库，没有写入远程项目，没有调用千问或上传媒体。
- PostgreSQL 17.6，Supabase CLI 2.75.0，psql 14.18。
- 数据库有 35 条迁移，已完整应用至 `20261108090434_ai_learning_reports`，包括有效本地覆盖与云端观察事实聚合。
- 代码基线为 `eef9c106c3a4b74b642d00dfdea289257657fca1`，加本记录所述的 `insights.test.sql` 测试修正。应用代码未由此次测试工作修改。
- 每个套件在事务中回滚测试写入。并发套件使用两个本地 dblink 连接，完成后显式删除其独立连接创建的固定测试身份。

执行方式（连接变量只允许指向本地隔离库）：

```sh
for test_file in supabase/tests/*.sql; do
  psql "$LOCAL_TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$test_file" || exit 1
done
```

## 逐项结果

| 套件                                    | 主要核验                                                                                             | 结果   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| `account_sync.test.sql`                 | 历史账号迁移实现、所有权、一次性凭证及锁序回归；旧入口仅在回滚事务内临时授权                         | 退出 0 |
| `database.test.sql`                     | 任务与本次学习状态机、所有权隔离、原子操作、确认完成和级联删除                                       | 退出 0 |
| `guided_planning.test.sql`              | 计划原子保存、幂等请求、采用版本快照、活动学习期间结构锁、已完成步骤保留                             | 退出 0 |
| `insights.test.sql`                     | 事实容量、时间段、时区与夏令时、统计完整性、回滚权限及真实双连接锁序                                 | 退出 0 |
| `learning_reports.test.sql`             | 服务端专属权限、报告租约、同快照缓存、授权撤回后拒绝写回、本人读取和清理                             | 退出 0 |
| `learning_reports_adversarial.test.sql` | 数据变化不重复周报周期、旧租约失效、三次上限、清空记录不能重置日额度、导出预期身份、实际执行版本过滤 | 退出 0 |
| `observation_report_evidence.test.sql`  | 本地有效覆盖与稀疏云端窗口分别统计，未知窗口不冒充有效样本，业务删除清理云端事实                     | 退出 0 |
| `password_account.test.sql`             | 新鲜密码 AMR 与真实 Auth Session、匿名/他人会话/过期认证拒绝、本人注销及旧入口撤权                   | 退出 0 |
| `process_observation.test.sql`          | 默认关闭、分项授权、在途请求/额度、禁止客户端伪造云端结果、连续窗口、撤回后丢弃与有效覆盖去重        | 退出 0 |

## 本轮发现并修正的测试缺陷

初次执行 `insights.test.sql` 时，第二次 `dblink_send_query` 发出“另一个命令仍在执行”的 NOTICE。第一个查询结果没有额外消费尾部空结果，导致后续提醒写入实际未发出；原来的 `saved_response <> expected` 也会让 NULL 跳过断言。

修正后：

1. 两个异步查询均必须明确返回发送成功值 1。
2. 每次读取业务结果后，再读取并断言尾部结果为空，之后才能复用连接。
3. 提醒响应使用 `IS DISTINCT FROM` 严格断言，NULL 也会失败。
4. 真正的任务插入与提醒更新均在另一连接持锁时发出，持锁连接使用 NOWAIT 检验行锁顺序，释放后核验业务结果。

这与 [PostgreSQL 17 的 dblink_get_result 使用要求](https://www.postgresql.org/docs/17/contrib-dblink-get-result.html)一致。修正后单独复验和全套回归均通过，不再把该分支的未执行视为通过。

## 回滚与权限复核

最终回读：`auth.users`、`tasks`、`study_sessions`、`ai_reports` 与 `private.ai_report_jobs` 均为 0 行，没有遗留验收身份或业务记录。

`authenticated` 对以下历史入口的 EXECUTE 权限均仍为 false：`prepare_account_merge(text,text)`、`consume_account_merge(text)`、`prepare_account_deletion(text)`、`delete_my_account(text)`。测试事务中的临时授权没有泄漏至实际应用权限。

关键文件 SHA-256（本次验收快照）：

```text
e537f5b3fab11e3fd0d87b7547cb21047ae3f38730c12142210a7262d3401745  supabase/tests/insights.test.sql
e786e870011105ce617805c9994d2af82c7aa4bf395cef2c44a92d574c056fb1  supabase/tests/learning_reports_adversarial.test.sql
09873316482a4077d7c4cbf1a0487c8bcf06af3b3f08960b5c1003abb9bd38e8  supabase/migrations/20261108090434_ai_learning_reports.sql
13a891ad5520cfe6f851768e384683f4cdece880ba187e463d5d5537c77ab0e2  supabase/migrations/20261108085214_effective_observation_insights.sql
3f868a2b1e88cc3e29cd9f3c208786d6cb1c2b31573849a666e700dcead9a10d  supabase/migrations/20261108090209_cloud_observation_report_facts.sql
```

## 不能由本记录证明的事项

本记录不代表 Preview/Production 已发布、远程 Auth 开关或 Advisors 已通过，也不证明真实摄像头准确率、云端模型实际效果、免费额度开关或自动报告的真实日历运行。SQL 中的观察窗口与模型结果均是明确的隔离测试夹具；真实视觉与线上验收需分别留证。
