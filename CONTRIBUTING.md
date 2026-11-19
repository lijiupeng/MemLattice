# 参与贡献

先说清定位：这是一个**源码可见、禁止商用**的个人项目（[PolyForm Noncommercial 1.0.0](LICENSE)）。你可以自用、修改，但提交进来的代码会以同一许可分发。

## 环境

- Node.js 22 或更高（`.nvmrc` 里锁了大版本）
- 不需要 Docker，也不需要 PostgreSQL——默认就是 SQLite 单文件

```bash
git clone <repo>
cd MemLattice
cp .env.example .env      # 改掉 MEMLATTICE_TOKEN
npm install
npm run dev               # http://localhost:8787
```

改管理端界面时再装前端依赖：

```bash
npm run web:install
npm run web:dev           # http://localhost:5173，API 自动代理到 8787
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 起服务（自动迁移 + 建默认用户与常驻块） |
| `npm run typecheck` | 后端 `tsc --noEmit` + 前端 `vue-tsc` |
| `npm test` | 核心算法单元测试 |
| `npm run smoke:sqlite` | SQLite 全链路（无需外部依赖，CI 必跑） |
| `npm run smoke` | PostgreSQL 真库端到端（内嵌 PG，比较慢） |
| `npm run smoke:http` | HTTP + MCP 端到端，需要先 `npm run build:all` |
| `npm run build:all` | 后端 `dist/` + 前端 `web/dist/` |

CI 会跑：类型检查、单元测试、SQLite 全链路、构建，以及一个独立的 PostgreSQL 冒烟 job。PR 提交前请至少在本地跑完前三项。

## 改数据库查询时必须注意

项目同时支持 SQLite 与 PostgreSQL，查询要写成两边都能跑的形态：

- 数组参数用 `IN (${ids})` 展开，不要写 `= ANY(...)`
- 批量插入用 `${ctx.sql.values(rows)}`，不要用 `unnest(...)`
- 结构化值用 `${ctx.sql.json(value)}`，不要直接传 `JSON.stringify`
- 需要按方言分支时用 `ctx.sql.dialect === 'pg'`，并在注释里写清为什么要分叉
- 日期一律作为参数传入，不要在 SQL 里写 `now()` 或 `interval`
- 提交前跑 `npm run smoke:sqlite` 与 `npm run smoke`，只说跑了其中一个，就在 PR 里注明

如果是 SQLite 独有的差异（比如没有分区表、没有 `pg_trgm`），在 PR 描述里说明，不要静默降级。

## 代码约定

- 注释只写**为什么**，不复述代码在做什么
- 不留注释掉的旧实现，也不写「xx 修改」这类改动史
- 同一个能力不要同时存在两套实现；确认旧路径没有调用方后删掉
- 新增配置项要同时考虑：环境变量默认值、`/settings` 页、`.env.example`、README 的配置表

## 提交信息

前缀沿用现有风格：

```
feat: 新增某个能力
fix: 修正某个行为
refactor: 重构但不改行为
docs: 文档
chore: 构建、依赖、杂项
```

标题写清「改了什么」，细节放正文。

## 提 PR

1. 一个 PR 只做一件事
2. 描述里写清：解决什么问题、改了什么、怎么验证的
3. 勾选 PR 模板里的检查项时，只勾真正跑过的
4. 破坏性变更（接口字段、默认值、迁移）必须单独说明

## 报告问题

- 行为不符合预期 → 用 Bug 模板开 issue
- 安全问题 → 不要开公开 issue，见 [SECURITY.md](SECURITY.md)
- 用法问题 → 先看 README 的「已知限制」，很多「记忆不准」是关键词由调用方传入导致的
