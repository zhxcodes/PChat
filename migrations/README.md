# migrations/ —— D1 迁移（唯一账本：d1_migrations）

本目录里的 `*.sql` 由 `wrangler d1 migrations apply` 按**文件名顺序**执行，
执行记录写入 D1 的 `d1_migrations` 表。**这张表就是唯一账本**，不存在第二份迁移记录，
也不需要任何人手工维护。

## 谁能触发迁移

| 入口 | 谁用 | 命令 | 目标 |
|---|---|---|---|
| GitHub Actions（`.github/workflows/deploy.yml`） | 普通 fork 用户，零命令行 | push 到 `main` 后自动执行 | 远程 D1 |
| 开发者手动（兜底） | 有 Node.js + wrangler 的人 | `npx wrangler d1 migrations apply DB --remote --force` | 远程 / 本地 |

两条路径执行的是**同一批文件、同一张账本**，可以随时切换，不会出现「两套记录」。
账本由 Wrangler 全自动托管：**不要手工 `INSERT`，也不要手工删除 `d1_migrations` 里的行。**

## 命名规范

```
YYYYMMDDHHMMSS_描述.sql
例：20261120000000_baseline.sql
    20261201093000_add_contact_source.sql
```

- 时间戳用 14 位数字（UTC），保证不同人并行开发时顺序稳定；
- 描述用小写英文 + 下划线，简短说明做了什么；
- 不要在顶层放 `001_xxx.sql` 这类旧格式文件（Wrangler 会按名字排序执行，容易踩坑）。

## 基线（baseline）：已冻结

`20261120000000_baseline.sql` 是全量结构基线，内容全部是 `CREATE TABLE/INDEX IF NOT EXISTS`，
**幂等**：全新库一次建出完整结构，老库重复执行也不会有副作用。

关于基线，只有三条规则：

1. **已发布，不可修改**。线上库已经把它的文件名记进 `d1_migrations`，
   改内容不会让它重跑，只会让「线上已执行」和「仓库里的内容」悄悄不一致。
2. **不承载破坏性变更**。要改结构，一律新增一条带时间戳的迁移。
3. **不要在 D1 Console 里手动执行它**（包括 `schema.sql`）。
   手动执行不会写账本，之后 Wrangler 会以为库是空的。

## 写一条新迁移的原则

1. **幂等优先**：能用 `CREATE ... IF NOT EXISTS` 就不要用裸 `ALTER`。
2. **一条迁移只做一件事**：结构变更与数据回填分开。
3. **破坏性变更走 expand-contract**，至少拆成三次发布：
   1. expand：新增列 / 新表（可空、带默认值），旧代码照常跑；
   2. migrate：双写或回填数据，代码同时兼容新旧结构；
   3. contract：确认无回滚需求后，再用一条迁移删掉旧列 / 旧表。
   **不要**在同一条迁移里「删列 + 改业务逻辑」，否则回滚时会同时失去数据与代码。
4. **不做长事务批量重写**：D1 单条语句有大小限制，大批量回填要分批（例如按 user_id 分片）。
5. **不回改已发布的迁移**：账本按文件名记录。要修正就新增一条迁移。

## 老库怎么办

0.10 之前的老库需要先补齐历史结构（`ALTER TABLE` 增量，不可重复执行）。
这些历史脚本不随本上传集发布（维护者本地保留）；普通 fork 用户不需要它们 ——
全新数据库由基线一次建出完整结构。已经是 0.10+ 的库直接跑迁移即可，
基线对它是空操作，只会补上账本记录。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `duplicate column name: xxx` | 在已有新列的库上重复执行了非幂等迁移 | 不要再跑；查 `d1_migrations` 确认记录 |
| `no such table: d1_migrations` | 从没跑过 `migrations apply` | 跑一次迁移即可，Wrangler 会自动建表 |
| Actions 日志里没有迁移步骤 | 未配置 Secret `D1_DATABASE_ID`（首次部署会跳过） | 按 docs-src/database.md 补齐 Secret 后重跑 |
| 迁移成功但登录 500 | 库连错了 / Pages 的 `DB` 绑定指向另一个库 | 对比 `d1_migrations` 与实际绑定库的 ID |
