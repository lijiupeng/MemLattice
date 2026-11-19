# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.12] - 2026-11-16

### 修复

- **安装后看不到使用说明书**：播种原本写进 `skills/default`，而这个槽是「通用经验」，用户往往已经放了别的手册（QQ 操作、项目约定），于是被「已有内容」判定跳过。现在改成写入独立的 `skills/readme` 槽——`skills` 下每个槽都会进经验索引，default 保持用户原样
- `seed-cli` 幂等收口：内容相同时不重写，但 `rules` 的引用行仍会检查补齐（之前若加 `return` 会连引用一起跳过）

## [0.1.11] - 2026-11-16

### 文档

- `docs/03-视频脚本.md` 加两段：**镜头 9 · 从 SurfCore 搬过来**（`/memlattice SURFCORE迁移` + 完全权限，老用户一键迁移人格、记忆、提示词）、**镜头 12 · 它会睡觉**（睡前整理拟人化）。总时长 4:40 → 5:50，章节进度条与翻车点同步更新
- `dsh/memlattice/SKILL.md` 补两处约定：迁移入口的六步流程（先问一起做还是分开做、需要完全权限、顺序固定、每步报结果、原件不动、给后续动作），睡前整理的说话方式（当睡觉不当维护任务，只报结论不列清单，没什么可整理就别开口）

## [0.1.10] - 2026-11-16

### 文档

- `SURFCORE.md` 补「用完任何工具都必须重启 DSH 应用或服务」：按改动文件列出重启单位（`bridge.js` → QQ 桥接；`plugins/*`、`agent-presets/*`、profile patch → DSH 主程序），并记录了 2026-11-16 白名单只重启桥接仍被拒的实测时间线，附进程启动时间与文件修改时间的比对命令
- 同批把 `bridge import` 只搬 persona、白名单执行期拦截、控制台令牌对不上等在实战里踩到的偏差补进手册

## [0.1.9] - 2026-11-16

### 新增

- **安装时播种使用说明书**：`install` 装完调一次 `dist/seed-cli.js`，从 `SKILL.md` 摘「什么时候用 / 写入约定 / 纠正与反馈 / 睡前整理 / 人设与规则怎么改 / 隐私」六节（2540 字）写进 `skills` 第一条，并在 `rules` 末尾加一句引用。`skills` 已有内容就跳过，不覆盖用户自己写的；`bootstrap` 仍然不写内容，删库重建不会自动恢复

## [0.1.8] - 2026-11-16

### 变更

- 运维技能不再随初始化写进 `skills` 块，改成包内文档 `dsh/memlattice/SURFCORE.md`（分割 QQ 提示词 / 转移记忆人格卡 / 屏蔽提示词 / 只清文件），`SKILL.md` 末尾加一节指向它。装包时跟着技能目录一起落到 `~/.dsh/skills/memlattice/`
- `bootstrap` 回退成只建块，不再往 skills 塞内容；原先写进去的「【工具·…】」条目不再自动维护

## [0.1.7] - 2026-11-14

### 修复

- **老库缺表导致 `memory.start` 报 `no such table: mem_triage`**：和缺列同源——SQLite 的 001 只应用一次，后来新增的表在旧库上补不上。`001_init.sql` 全是 `CREATE TABLE/INDEX IF NOT EXISTS`、没有 INSERT/ALTER，天然幂等，所以现在 SQLite 每次启动都把全量脚本再跑一遍，缺的表和索引自动补齐

## [0.1.6] - 2026-11-13

### 修复

- **老库缺列导致卡片列表报 `E_INTERNAL`**：SQLite 的迁移是「整份 001 跑一次就记一笔」，后来往 001 里补的 `mem_card.hit_count` 在旧库上永远补不上。现在 `migrateUp` 末尾按需 `ALTER TABLE` 补列，重复列视为已应用；以后新增列记得加进 `SQLITE_REQUIRED_COLUMNS`
- **常驻层技能条目没有一句话总结**：`ensureSkillNotes` 只写 content 没写 summary，页面显示「（未填写一句话总结）」。现在同时写入「surfcore 转换技能」这句标题

## [0.1.5] - 2026-11-13

### 新增

- `dsh-memlattice web [端口]`：打开 Web 控制台。插件只拉起 `mcp-stdio`，前端没有进程托管；这条命令补上 `WEB_DIR`、`SQLITE_PATH` 等环境后启 `dist/index.js`，与 `serve` 共用同一个本地库

## [0.1.4] - 2026-11-13

### 新增

- 首次初始化就把三条运维技能写进 `skills` 块：分割 QQ 提示词、转移记忆人格卡、屏蔽提示词。装完直接可用，不需要另跑脚本；按开头片段判重，重复初始化不会重复写；超出块上限时静默放弃，不挤已有内容

## [0.1.3] - 2026-11-13

### 修复

- stdio 入口默认关闭 `HOOK_CHECK`：DSH 直连 `dist/mcp-stdio.js` 时不经过 `serve.mjs`，`memory.start` 仍会下发 `hook_check`，模型于是去找 `~/.codebuddy/hooks/mem-recall-gate.py`、甚至准备按 #123 去装。现在 stdio 默认不下发，需要自检的客户端显式设 `HOOK_CHECK=on`
- 组合包挂载条目也显式写入 `HOOK_CHECK=off`，双保险

### 变更

- 人格块上限 2000 → 2200 字，默认检索预算 1200 → 2200 tokens，与 SurfCore 的 `persona.compactChars` / `injectMaxChars.qq` 对齐；老库的块上限由 `bootstrap` 幂等补齐

## [0.1.2] - 2026-11-12

### 变更

- 热度改由「采用」驱动：召回命中只记曝光次数，不再加热度、不计采用——被拉进上下文不等于被用上
- `memory.correct` 不再加热度，改为小幅上调置信度
- 排序按采用率折减：曝光 ≥5 次且采用率低的卡最低折到 0.6 倍，保留可搜但不再挤占预算
- 冷判定豁免反复被召回的卡：曝光 ≥3 次不压成骨架

### 新增

- `memory.feedback`：`wrong` 下调置信度、`irrelevant` 记噪声票、`helpful` 视为一次采用，全部留审计
- `memory.sleep`：只读的整理压力与待办清单——未成卡原文、未收口事件、未固化主题、疑似重复、低置信、接近淡忘；服务端只统计，处理由调用方决定
- 会话初始化返回 `maintenance`，有积压时给一句提示
- 新增 `HOOK_CHECK=off` 开关：DSH 组合包与 CLI 安装会关掉会话钩子自检，`hook_check` 只下发给需要它的客户端
- 修正经验淘汰判据：改按条数（30 条）而不是正文 token——正文不进常驻上下文，按它淘汰等于惩罚写得详细。`SKILL_L1_MAX_TOKENS` 改为限制索引行，超了少列几条，不动已存的经验
- 下线不再静默：近 7 天有经验被巡检淘汰时，`memory.start` 通过 `notices` 提示一句
- 压骨架交给调用方：巡检只统计待淡忘候选（`decay_candidates`），不再自动压；新增 `memory.forget({ mode: "skeleton" })` 执行压骨架（摘要截到 80 字、断开原文），重要 / 钉住 / 人物关系类仍受保护
- 巡检支持启动补跑：完成时间记进 `app_setting`（`life.last_patrol_at`），启动时距上次超过 24 小时就异步补一次，解决本地机器关机导致定时任务永不触发的问题
- `memory.correct` 改常驻块后返回 `reload_required`：L1 只在初始化注入，不重新调用就还在按旧内容行事
- Web 端「召回预览」改名「记忆检索」，措辞改成人话；新增「会话预览」页，展示 `memory.start` 实际会返回什么（新增 `GET /api/start/preview`，不落快照、不改计数）
- `memory.triage`：把清单里判断过、决定不处理的项记下来，之后不再重复列出；`mode=clear` 可撤销（撤销后重新回到清单）；新增 `mem_triage` 表，PG 迁移 `012_triage.sql`
- 主题清单跳过已被经验通过 `ref_terms` 引用的词，避免重复提示「该提炼」
- `mem_card.hit_count` 列，PG 侧迁移 `011_card_hit_count.sql`
- 容量口径与 SurfCore 对齐：人格块上限 2000 → 2200 字（`persona.compactChars`），默认检索预算 1200 → 2200 tokens（`injectMaxChars.qq`）。老库的块上限由 `bootstrap` 幂等补齐

### 升级说明

- SQLite 用全量建表脚本、没有逐条增量迁移：已有 SQLite 库需删库重建。内测期无外部用户，不做兼容层

## [0.1.1] - 2026-11-11

### 新增

- DSH 组合包 `dsh-memlattice`：`package.json` 声明 `dsh.bundle.patch` 指向配置层，配置里只写 `npx -y dsh-memlattice@<版本> serve`；运行时路径、数据库位置与技能同步都由 `serve` 在进程内解析，换机器不用改配置
- 面板安装与 CLI 安装并存；新增 `install` / `uninstall` / `doctor`

## [0.1.0] - 2026-11-11

首个公开版本：源码可见、禁止商用（PolyForm Noncommercial 1.0.0）。

### 新增

- 四层记忆结构：常驻层（人设 / 规则 / 经验索引）、滚动索引、事件卡、原始明细
- 召回链路：词典匹配抽种子 → 同义扩展 → 子图 PPR 扩散 → 两级预算打包，注入量有硬上限并记录每条丢弃原因
- 写入链路：支持攒批、显式关闭成卡、追加到已有卡、批量写入
- 生命周期：热度半衰期、冷记忆过滤、骨架化、原文归档、回收站与物理清除
- MCP 十工具，stdio 与 Streamable HTTP 两种传输
- Web 管理端：卡片列表与详情、径向图谱、召回预览、待审队列、回收站、审计、设置
- 运行时参数页：26 项参数落库并热更新，按「库 > 环境变量 > 默认值」三层取值
- **双后端**：默认 SQLite 单文件，零外部依赖；PostgreSQL 可选，支持分区表与 pgvector
- DSH 技能包与一键安装脚本（Windows / macOS / Linux）

### 已知限制

- 单用户单 Token，无多租户
- SQLite 模式不支持 pgvector 与 `pg_trgm` 相似度
- 运行时参数的热更新只作用于当前进程
