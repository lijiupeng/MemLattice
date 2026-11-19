# MemLattice

**给 AI Agent 用的长期记忆库。** 让模型跨会话记住一个人，并且成本不随对话轮次增长。

默认 SQLite 单文件，零外部依赖；MCP（stdio + HTTP）给 Agent 用，Web 管理端给人用。

**四个不限**：不限会话、不限 agent、不限模型、不限设备。记忆存在你自己的库里，换个客户端、换个模型、换台电脑，照样接得上。

![license](https://img.shields.io/badge/license-PolyForm--Noncommercial--1.0.0-red)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![database](https://img.shields.io/badge/database-SQLite%20%7C%20PostgreSQL-blue)
![mcp](https://img.shields.io/badge/MCP-10%20tools-purple)

> 采用 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)：源码可见、仅限非商业用途。它不是 OSI 认可的开源许可。详见 [许可](#许可)。

---

## 它解决什么问题

大多数"AI 记忆"方案把全部历史塞进上下文，越聊越贵、越聊越糊。MemLattice 把记忆切成四层，每轮只注入该注入的部分：

| 机制 | 做法 |
|---|---|
| **分层** | L1 常驻（人设 / 规则 / 经验索引）、L1.5 滚动索引、L2 事件卡、L3 原始对话；先读高层，按需下钻 |
| **联想** | `词 × 意图` 二维倒排 + 词图，子图上跑 PPR 扩散，换个说法也能命中 |
| **固化** | 热度够高、被多个事件引用的经验，收敛成一条索引，正文按 id 现取 |
| **淡忘** | 冷记忆移出常驻 → 压成骨架卡（断开原文）→ 归档 → 进回收站；人物类有保底，不会被忘干净 |

关键取舍：**服务端不调用任何模型**。摘要、意图、关键词由调用方传入，服务端只做规则兜底。因此写入零模型成本、结果确定、可离线。

---

## 特性

- **预算硬约束**：一次召回注入多少 token 有上限，超出直接拒绝；每个被丢弃的条目都带原因（`budget` / `cold` / `weak_trimmed` / `df_filtered` / `limit_truncated`）
- **可下钻**：常驻层只放索引，正文按 `block_id` 现取，用到才算一次调用
- **可回看**：每次召回的实际注入内容落快照，事后能核对"当时到底给了模型什么"
- **可撤销**：更正有版本快照，删除进回收站，固化条目可撤销
- **双后端**：同一个代码路径支持 SQLite 与 PostgreSQL，切换只改一个环境变量
- **可调**：26 个运行参数在 Web 端改，保存即生效，不用重启
- **可自托管**：默认全本地，数据不出机器

---

## 快速开始

### 1. 本地直接跑（推荐，SQLite）

```bash
cp .env.example .env      # 至少改掉 MEMLATTICE_TOKEN
npm install
npm run dev               # 自动建库到 ./data/memlattice.db
```

打开 <http://localhost:8787> 是 Token 页，填入 `MEMLATTICE_TOKEN` 后进入管理端。数据就是一个文件，备份即复制。

不配 `DATABASE_URL` 就是 SQLite；给了连接串就自动走 PostgreSQL，也可以用 `DB_DIALECT=pg|sqlite` 强制指定。

想先看效果，灌一份演示数据（19 张卡、62 个关键词、332 条词边）：

```bash
npm run seed:demo
SQLITE_PATH=./data/demo.db npm start
```

演示库独立于主库，随时删掉重建。

### 2. 在 DSH 里安装

**方式一：作为组合包（推荐）**

在 DSH 的插件面板里搜 `dsh-memlattice`，或者用命令行：

```bash
dsh plugin --profile <profile> add dsh-memlattice
```

包内声明了 `dsh.bundle`，`add` 会把 MCP 服务端这一行并进 profile 的配置层，技能也会在服务端首次启动时同步到 `$DSH_HOME/skills/memlattice`。配置文件不用手改。

装完先预热一次运行时缓存，避免首次启动 MCP 时因下载超时：

```bash
npx -y dsh-memlattice@0.1.1 --help
```

然后重启 DSH 网关。

**方式二：CLI 安装**

```bash
npx -y dsh-memlattice install
```

它直接把运行时解到 `~/.memlattice/versions/<版本>`、写好 profile 的 `cordis.patch.yml`（绝对路径版）、拷技能，最后真拉起一次 `memory.start` 做探活。适合不想把插件装进 profile 依赖树的场景。

从源码安装则是先打运行时包、再跑同一个安装器：

```bash
npm run build && npm run pack:runtime
node dsh/pack/bin/cli.mjs install
```

`--profile` 不指定时自动探测（机器上只有一个 profile 就直接用它）。`--scope project --project <目录>` 规格装进项目级技能目录。`uninstall` 卸载（`--purge` 连运行时与记忆数据一起删），`doctor` 随时自检。

### 3. Docker + PostgreSQL

容器只跑 app，数据库用宿主机已有的 PG：

```bash
cp .env.example .env          # 改掉 MEMLATTICE_TOKEN，必要时设 DOCKER_DATABASE_URL
docker compose up -d --build
```

宿主机 PG 需要：`listen_addresses` 放行 Docker 网关；`pg_hba.conf` 加一行 `host all all 172.16.0.0/12 scram-sha-256`。缺 `pgvector` 只会关掉向量召回，关键词与词图照常；`pg_trgm` 是必需扩展。

想用容器自带的 PG：

```bash
docker run -d --name memlattice-pg -p 5432:5432 \
  -e POSTGRES_USER=memlattice -e POSTGRES_PASSWORD=memlattice -e POSTGRES_DB=memlattice \
  pgvector/pgvector:pg16
npm run migrate && npm run dev
```

### 4. 生产构建

```bash
npm run build:all    # dist/ + web/dist/
npm start
npm run worker       # 可选：独立巡检进程，--once 只跑一次
```

---

## 接入 MCP

### stdio（桌面客户端）

```json
{
  "mcpServers": {
    "memlattice": {
      "command": "node",
      "args": ["/absolute/path/to/MemLattice/dist/mcp-stdio.js"],
      "env": { "SQLITE_PATH": "/absolute/path/to/MemLattice/data/memlattice.db" }
    }
  }
}
```

用 PostgreSQL 时把 `SQLITE_PATH` 换成 `DATABASE_URL`。

### Streamable HTTP（远程 / 多客户端）

- 端点：`POST /mcp`，鉴权 `Authorization: Bearer <MEMLATTICE_TOKEN>`
- 服务端在 `initialize` 响应里下发 `Mcp-Session-Id`，后续请求带上该头
- `GET /mcp`（SSE 续流）与 `DELETE /mcp`（结束会话）同样需要会话头

```json
{
  "mcpServers": {
    "memlattice": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer <MEMLATTICE_TOKEN>" }
    }
  }
}
```

---

## 十个工具

| 工具 | 用途 | 要点 |
|---|---|---|
| `memory.start` | 会话初始化，常驻层的唯一注入点 | 新会话第一个调用；返回 `persona` / `rules` / 经验索引与 `recall_id`。之后的 `recall` 不再返回常驻层，避免历史里堆叠副本 |
| `memory.recall` | 按话题召回事件卡 | `budget_tokens` 默认 2200、上限 4000；弱关联只出提示行、不占预算；`cards[].id` 可直接作 `append_to`；`source=external` 的内容需核实后再当事实 |
| `memory.expand` | 下钻一跳 | `card_id` 取原文，`block_id` 取经验正文，`term` 取词的一跳邻居 |
| `memory.write` | 写入并成卡 | 支持攒批：多轮 `messages` + `close=true` 收尾；不传 `event_id` 时自动续写同 `scope` 下最近未成卡事件（默认 30 分钟窗口）；`append_to` 立即并入原卡 |
| `memory.write.batch` | 批量写入 | 最多 20 组，组间隔离，单组失败只回填该组错误 |
| `memory.cards` | 只读搜卡 | 按关键词 / 意图 / 场景 / 时间筛选，用于定位要更正或遗忘的卡 |
| `memory.sleep` | 整理压力与待办清单 | 只读：未成卡原文、未收口事件、未固化主题、疑似重复、低置信、接近淡忘；不写库不做判断 |
| `memory.triage` | 清单分诊 | 批量标记「已评估、不处理」，之后不再出现在清单里；`mode=clear` 撤销标记；只影响清单，不动记忆 |
| `memory.feedback` | 纠错表态 | 只在内容有误（`wrong`）或完全无关（`irrelevant`）时调用；正常使用由 `expand`/`append_to` 自动记账 |
| `memory.correct` | 更正卡片、常驻块或词 | `skills` 支持 `slot=skill:<term_id>`；一句话描述 ≤60 字，详细描述默认 ≤4000 字 |
| `memory.forget` | 软删或物理清除 | `purge` 需 `confirm=true`，且先进回收站保留 7 天 |
| `memory.pending` | 查审核结果 | 审批只能人工在 Web 端完成 |
| `memory.inspect` | 回看某次召回 | 返回完整的注入内容、被丢弃项及原因，不重跑召回、不改热度 |

---

## 运行时配置

管理端 `/settings` 页集中了 26 个参数，保存即写入数据库并热更新到进程内存：

| 分组 | 覆盖的配置 | 例子 |
|---|---|---|
| 召回预算 | `DEFAULT_BUDGET_TOKENS`、`MAX_BUDGET_TOKENS`、`WEAK_HINT_LIMIT` | 默认注入 2200 tokens（与 SurfCore 的 2200 字注入上限对齐） |
| 淡忘与生命周期 | `*_HALF_LIFE_DAYS`、`COLD_*`、`SKELETON_MAX_CHARS`、`KEEP_HISTORY_CARD_RATIO`、`SKILL_*`、`RAW_*_DAYS`、`TRASH_RESTORE_DAYS`、`RECENT_*` | 卡片半衰期 30 天、回收站 7 天 |
| 写入与成卡 | `CONDENSE_TURN_THRESHOLD`、`CONDENSE_MAX_ATTEMPTS`、`WRITE_AUTO_RESUME_MINUTES`、`OPEN_EVENT_SWEEP_HOURS` | 攒满 12 轮成卡 |
| 常驻层审核 | `BLOCK_APPROVAL_LABELS` | 只让 rules 需要人工确认 |
| 自动巡检 | `WORKER_ENABLED`、`WORKER_HOUR` | 每天 3 点；启动时距上次超过 24 小时会异步补跑一次 |

- 取值三层：数据库行 > 环境变量 > 代码默认值，页面逐项标注来源并显示默认值。
- 越界或互相矛盾的值会被拒（如默认预算大于上限、清除天数小于归档天数）。
- 巡检开关与触发时刻需重启生效，页面已标注；其余参数立即生效。
- 端口、令牌、数据库连接、来源白名单、日志级别由部署环境决定，页面只读展示，令牌与连接串已打码。

完整的部署级环境变量见 `.env.example`。

---

## 架构

```
src/
  core/        token 估算、预算打包、PPR、热度衰减、打分、聚类、分词、同义扩展
  db/          双后端驱动（dialect / pg / sqlite）、迁移执行器、bootstrap
  services/    memory（召回/下钻/写入/更正/遗忘）、governance、lifecycle、indexing
  api/         REST、MCP（13 工具 + 会话头）、鉴权与错误映射
  index.ts     单进程入口：REST + MCP + 静态资源 + 巡检调度
  mcp-stdio.ts stdio 入口
  worker.ts    独立巡检进程
web/           Vue 3 管理端（图谱、卡片抽屉、记忆检索、会话预览、审计、设置）
migrations/    PostgreSQL 增量迁移（每步都带回滚脚本）
  sqlite/      SQLite 全量建表
dsh/           DSH 技能包（memlattice/）与发布包安装器（pack/）
.github/       CI、issue 与 PR 模板
```

### 召回链路

```
读常驻层 + 最近 15 条事件索引
→ 词典匹配（词名 + 别名）抽种子，未命中再用分词兜底
→ 种子沿同义边走一跳（权重 ×0.6）
→ 取 2 跳子图（节点上限 5000）
→ 子图 PPR（d=0.85，20 轮）→ top 20 且 df≥2
→ 倒排取卡（≤60）→ 打分 → 强/弱分级
→ 两级预算打包：常驻层先按比例装填，剩余给强关联卡
```

- **强关联**：`ppr_norm ≥0.30` 且最近一次命中在 30 天内 且与查询重合词 ≥2。新鲜度按「最近命中」算而不是创建时间，被反复用到的旧卡不会因为年头长被判死
- **热度**：只由「采用」驱动（下钻 +1.5、被新卡引用 +2.0、`feedback=helpful` +1.0）。召回命中只记曝光次数，不加热、不计采用——被拉出来不等于被用上。写入时按半衰期折算，不做定时全表刷新
- **采用率**：曝光 ≥5 次时按 `采用 / 曝光` 折减排序，最低折到 0.6 倍。噪声卡保留可搜，但不再挤占预算
- **冷记忆**：热度 <0.5、90 天未命中、且曝光不足 3 次，才进冷判定。反复被召回说明还有用，不压成骨架

### 写入与成卡

是否并入已有卡由调用方决定：先 `recall` 看上下文，是同一件事就传 `append_to`，否则新建。服务端默认不做相似度合并，`dedupe=true` 才启用兜底判定。

并入动作：摘要滚动合并（整体 ≤200 字）、关键词与实体取并集、新原文挂到同一张卡、热度 +2.0、版本 +1，并写审计。

### 生命周期

每日巡检（`WORKER_HOUR`）分批执行、幂等、可中断续跑：

1. 预建原文分区（PG）
2. 重试失败的浓缩任务，指数退避，超次数转人工队列
3. 收口超时未成卡的事件：能成卡的成卡，内容太少的归档
4. 经验超过 30 条时淘汰最冷的一条（只按条数，正文长度由每块自己的上限管）
5. 统计待淡忘候选，但**不再自动压骨架**——压骨架会断开原文且不可逆，改由 `memory.sleep` 时交给调用方判断（`memory.forget` 传 `mode=skeleton`）
6. 原文归档 → 回收站 → 清除

### 图谱

管理端用同心环布局：常驻层居中 → 关键词内环 → 记忆卡外环。悬停关键词会联动高亮相关的卡与共现词。另有连通分量聚簇视图，用于只看词间关系。

---

## 验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 核心算法单元测试 | `npm test` | 52 / 52 |
| 真库端到端（嵌入式 PostgreSQL） | `npm run smoke` | 74 / 74 |
| HTTP + MCP 端到端 | `npm run smoke:http` | 44 / 44 |
| SQLite 全链路 | `npm run smoke:sqlite` | 39 / 39 |
| 类型检查 | `npm run typecheck` | 后端与前端均通过 |

真库冒烟覆盖：迁移、鉴权与来源校验、常驻块审核链路、块上限、写入→浓缩、追加与版本、召回预算、丢弃明细、下钻取原文、审计前后值、冷记忆过滤、骨架化、软删/恢复/物理清除、图谱一致性、MCP 十工具。

SQLite 冒烟覆盖：全量建表、bootstrap 幂等、数组列读写、参数展开、日期与布尔绑定、写卡、召回、追加、列表、图谱、巡检。

---

## 已知限制

- 单用户单 Token；多租户需要扩展鉴权与行级隔离
- SQLite 模式没有分区表、没有 pgvector、没有 `pg_trgm` 相似度；语义召回与模糊相似度只在 PostgreSQL 下可用
- SQLite 的 `LIKE` 仅对 ASCII 不区分大小写；`ILIKE` 已统一改写为 `lower(...) LIKE lower(...)`
- 运行时参数的热更新只作用于当前进程，多实例部署需各自重启
- 服务端不做语义生成，摘要与关键词必须由调用方提供（这是刻意的取舍，不是缺失）
- Web 管理端没有移动端深度适配，窄屏可用但不精致

---

## 许可

采用 [**PolyForm Noncommercial License 1.0.0**](https://polyformproject.org/licenses/noncommercial/1.0.0)，SPDX 标识符 `PolyForm-Noncommercial-1.0.0`。

这是一个被 SPDX 收录、专门为软件写的「源码可见 + 禁止商用」许可，不是我自己编的条款。它不是 OSI 认可的开源许可。

| 场景 | 是否允许 |
|---|---|
| 个人研究、学习、实验、业余项目、自用 | 允许 |
| 慈善、教育、公共研究、公共安全/卫生、环保、政府机构使用 | 允许 |
| 阅读、克隆、修改源码 | 允许 |
| 分发副本（须随附本许可全文与 `Required Notice` 行） | 允许 |
| 分发修改版（须沿用同一许可，不能改成 MIT / Apache） | 允许 |
| 任何商业用途：售卖、订阅、集成进商业产品、提供付费服务 | 禁止 |
| 移除版权声明与 `Required Notice` | 禁止 |

两点说明：

- **它挡得住"改个名字洗成自己的开源项目"**：衍生作品必须继续沿用 PolyForm Noncommercial，不能换许可证，也不能商用。
- **它挡不住"别人非商业地 fork 并公开"**：PolyForm 允许非商业分发，只要带上许可全文。如果你要的是「任何情况下都不许再分发」，标准许可里没有这一款——那只能写专有版权声明（All rights reserved）再加单独授权，代价是连"源码可见"的法律含义都要自己解释。

完整条款见 [LICENSE](LICENSE)。需要商业授权请联系作者。

---

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。改数据库查询时请两个后端都验证：`npm run smoke:sqlite` 与 `npm run smoke`。

提交贡献即表示同意以 [LICENSE](LICENSE) 的同一许可分发。

## 致谢

分词用 [`@node-rs/jieba`](https://github.com/napi-rs/node-rs)，图谱用 [AntV G6](https://g6.antv.antgroup.com/)，MCP 协议实现基于 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)。
