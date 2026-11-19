# SurfCore 迁移手册

把 SurfCore 的角色、记忆、提示词迁到 MemLattice，或反过来关掉它自己的注入。

三个脚本随包分发，在 `runtime/scripts/` 下，通过 `dsh-memlattice` 子命令调用；源码仓库里对应 `scripts/*.mts`，用 `npx tsx` 跑，参数一致。

所有命令默认操作本地库 `~/.memlattice/data/memlattice.db`，与 `serve` 用的是同一份数据。

> 本机若没装全局 bin，用 `node <profile>/node_modules/dsh-memlattice/bin/cli.mjs` 代替 `dsh-memlattice`。
> Windows 上命令里的 `node` 用 DSH 自带运行时：`C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

---

## 开工前：最短路径

按这个顺序做，**不要每步停下来复查**；只有第 6 步需要人（重启 DSH）：

| # | 做什么 | 怎么调 | 一次成功的关键 |
|---|---|---|---|
| 1 | 看现状 | `detach status` + `prompt-off status` | 两个输出合起来就是全部现状，别再看第三遍 |
| 2 | persona 进 L1 | `bridge import` | 只搬 persona 是**正常**的（`记录：0 条`），别去修 |
| 3 | 补卡 | `memory.write.batch`（MCP） | 卡片摘要 40–200 字，关键词给 1–3 个 2–12 字实词 |
| 4 | rules / skills | `memory.correct`（MCP） | `patch.summary` **≤60 字**，否则 `E_BLOCK_LIMIT` |
| 5 | 白名单 + 关注入 | 改 `plugins/surfcore/qq-tool-restrict.mjs`；`detach disable` + `prompt-off apply`（一次放宽权限跑完） | 白名单只需改**一个文件** |
| 6 | 重启 | 桥接（agent 可做）+ **DSH（只能用户做）** | 两个都要，缺一白名单不生效 |
| 7 | 验收 | `tool-calls.jsonl` 里 `memory_start` 的 `ok=true` | 不要用「发消息试试」当唯一证据 |

两个最容易白烧一轮的判断：

- **写库报 `attempt to write a readonly database` ≠ 库坏了**，是 DSH 沙箱在拦工作区外的路径（见「执行环境的三条硬约束」）。
- **白名单改完只重启桥接 = 没改**。guard 在 DSH 主进程里，桥接进程里根本没有这段代码。

---

## 零、先问一句：一起做还是分开做

**开始动手前先弹一次窗**（`ask_user_question`），不要默认全套。三个动作改变的东西不一样：

| 动作 | 改什么 | 出错代价 |
|---|---|---|
| 搬人格 + 记忆 | 往 MemLattice 写 L1/L2（可回滚，留版本） | 低：写错了还能改 |
| 搬提示词（rules/skills） | 覆盖 L1 块，**整块替换** | 中：2000 字上限，超了直接报错；手改过的内容会丢 |
| 关注入（prompt-off / detach） | 动 SurfCore 的 `bridge.js` 与角色文件 | 高：顺序反了会「旧的没了、新的取不到」 |

弹窗给两个选项，把推荐放第一个（**同时在这一轮就告诉用户：最后需要你重启一次 DSH**，别做到最后一步才提）：

1. **一次做完（推荐）**——数据、规则、关注入一起做，一轮跑完。适合：库是空的、日志里还没有 MemLattice 的卡、想当天就把 QQ 切过来。
2. **只搬数据，先不关注入**——先把 persona / 记忆 / 规则搬进来，SurfCore 继续按老样子注入，观察几天再关。适合：旧提示词里还有没确认要不要保留的段落。
3. **只关注入，不搬**——**不要提供这个选项**。这就是踩过的空窗状态：`prompt-off.flag` 在、库是空的，QQ 醒来既没有旧人格也取不到新记忆（2026-11-16 现场：flag 从 11-14 就挂着，库 0 卡 0 块）。

判断当前是不是「半迁移」：`detach status` 看人格文件是否为空 + `memory.start` 看三个块是否为空。**任何一个为空就先补齐，别先去动注入。**

---

## 零点五、执行环境的三条硬约束（不先确认，后面每步都会还回来）

### 1. 沙箱：CLI 写库会被拒，`memory.*` 不会

agent 在 DSH 里跑 `pwsh` 时，会话落在 workspace-write 沙箱，而 `~/.memlattice/data/memlattice.db` 和 `surfcore/` 都在工作区外。写库的 CLI 命令会报：

```
失败： attempt to write a readonly database | SQL: INSERT INTO app_user (external_id, display_name) ...
```

**这不是 SQLite 锁，也不是权限问题**——ACL 是好的（`<你>` 拿 FullControl，手动 `[IO.File]::Open(...,'ReadWrite')` 反而报「访问被拒绝」）。就是沙箱。

处理原则：

- 搬内容的动作（persona / rules / skills / 卡片）**全程走 MCP 的 `memory.write` / `memory.write.batch` / `memory.correct`**——MCP 子进程不在这个沙箱里，这些调用一次都不会失败，也不要加权限。
- 只有**改文件**的动作（`bridge import`、`prompt-off`、`detach`、`web`）才需要 CLI，这些用**一次**放宽权限的调用批量跑完（例如 `detach disable` + `prompt-off apply` 在同一个命令里），不要一条一条试权限。
- 让用户在自己终端敲也是一条路，但那就把迁移拆成两个执行者，状态容易对不上——只在 agent 确实没权限时才这么做。

### 2. 两次重启，缺一不可，而且第二次只能用户做

| 改了 | 必须重启 | 谁来做 |
|---|---|---|
| `src/bridge.js`（prompt-off 补丁） | QQ 桥接 | agent 可以做（见第六节「重启桥接」） |
| `plugins/surfcore/*.mjs`（工具白名单） | **DSH 主进程** | **只能是用户**——agent 自己跑在 DSH 里，重启就是自杀 |

所以第 0 节的弹窗里就要把「最后要重启一次 DSH」讲清楚；用户同意后，把除重启外的活全干完，再让他重启，然后验收。

### 3. 端口漂移：桥接只在启动时探测 DSH

DSH 桌面端每次启动换随机回环端口（实测 53465 → 55058），而 `config.dsh.baseUrl` 常常还是更早的旧值（这台机器上一直是 `http://127.0.0.1:3080`，那个端口根本没在听）。

`bridge.js` 只在**启动时**探测一次并写回 `config.json`，运行中不重探；并且从 DSH 的 shell 起桥接会继承 `DSH_WEB_URL`，于是**跳过探测**、直接钉死当前端口。

- 结论：**DSH 重启之后，桥接也要重启**，并且用普通终端 / `start.bat` 起（不带 `DSH_WEB_URL`），让它自己探测新端口；
- 不这么做的表现：「QQ 有消息、DSH 没反应」「所有 QQ 工具 401」；
- 判断：`netstat -ano | findstr :3100` 有监听、但 `config.json` 的 `dsh.baseUrl` 和 DSH 实际监听端口不一致，就是这一条。

---

## 一、分割 QQ 提示词

SurfCore 每次唤醒都会拼一大段提示词：设定、行为规则、工具手册、每轮变化的状态混在一起。这个脚本按段落切开分类，再决定各自去哪。

```bash
# 先只看分类，不写库
dsh-memlattice prompt-split --file 提示词.txt

# 确认后写入
dsh-memlattice prompt-split --file 提示词.txt --apply
```

分类口径：

| 类别 | 内容 | 去向 |
|---|---|---|
| 设定 | 【当前角色】【你的身份】 | 并入 rules |
| 规则 | 反AI味、积极性、收尾判断、Token 防爆破、沉睡前等待 | rules |
| 技能 | 表情包策略、语音状态、引导唤醒 | skills |
| 经历 | B站记忆 | L2 卡片 |
| 状态 | 时间、会话、令牌、消息快照 | 丢弃（每轮都变） |

`--apply` 是**整块覆盖**：rules 和 skills 会被替换成这次的分类结果，手动改过的内容会丢。改之前先 `memory.expand` 导出备份。

### 现实里没有「提示词.txt」

2026-11-16 那次，磁盘上根本不存在拼好的提示词全文——它是 `bridge.js` 每轮动态拼的，日志里也没有落盘。所以 `prompt-split` 没有输入文件可喂。可行做法是**从源码抽**。

**一次 grep 就能定位全部规则段**（`bridge.js` 97 万字节，别去翻）：

```
pattern: 反AI味|积极性|防爆破|首回复|沉睡前|【行动前】|【引用|【回复检查】|【引导唤醒】
```

命中点就是各段原文；配套的固定位置（2026-11-16 版本号，升级后可能偏几十行）：

| 内容 | 位置 |
|---|---|
| 规则行（Token 防爆破 / 反AI味 / 积极性 / 首回复 / 沉睡前） | `src/bridge.js` ≈14948–14975 |
| 唤醒拼装 `base = ...`（prompt-off 的补丁点） | `src/bridge.js` ≈15015 |
| 各 reason 分支尾巴（`bootstrap` = 【引导唤醒】/ `replyCheck` = 【回复检查】） | `src/bridge.js` ≈15051–15074 |
| 收尾判断 | `src/conversation-closure.js` `closurePromptBlock`（≈392） |
| 管理员/主人规则 | `src/admin-identity.js` `adminPromptBlock`（≈186） |
| 来源判断 / 隐私 | `src/self-identity.js` `PROVENANCE_RULES` / `buildProvenanceBlock`（≈69/84） |
| 表情包策略 | `src/sticker-lib.js` `buildStickerStrategyHint`（≈295） |

抽的时候保留原句，只压举例性措辞。然后用 `memory.correct` 直接写块，不必非走 `prompt-split`——分类器是按标题正则分流的，做不到「这条进 rules、那条进 skills」的精细控制。

### 先看 `config.json`，再决定 rules 里放多少

写之前花一次调用看一眼（`surfcore/config.json`），这三个值直接决定要抽哪些段：

- `admin.qq` / `admin.gentle`：**`gentle: false` 时 `adminPromptBlock` 返回空串**，管理员规则整段不存在，不要凭空补 380 字进去（本机就是 false）。
- `socialV2.tokenGuard.maxOutboundPerTurn`（本机 8）、`socialV2.wake.preSleepWaitMs`（本机 300000）、`socialV2.wait.defaultQuietMs`（本机 8000）：规则里出现的数字以这里为准，别照抄旧文档。
- `allow.private` / `allow.groups`：本机是「只开主人私聊、群聊为空」，群话术（@ / 引用 / 群名片）要相应弱化，否则规则和实际场景对不上。

### 块的真实容量（硬限制，超了抛 `E_BLOCK_LIMIT`）

| 块 | 上限 | L1 里注入什么 |
|---|---|---|
| persona | 2200 字 | 全文 |
| rules | **2000 字** | 全文 |
| skills（default 槽） | 4000 字 | **只有一行索引**，正文要 `memory.expand` |

这条决定了很多东西：

- **行为规则必须进 rules**。放 skills 等于没进提示词——L1 只出「#3 一句话描述」，模型不主动 expand 就是不知道。
- rules 2000 字很紧。2026-11-16 第二次实测：反AI味 75 + 积极性 165 + 收尾判断 330 + Token 防爆破 300 + 首回复 215 + 沉睡前 380 + 行动前/引用 + 来源判断 + 隐私 + 表情包一句话 = **1976 字**（没有管理员段，因为 gentle 关闭），刚好卡进。
- 放不下的长手册（表情包全策略、引用细则、唤醒/等待/收尾用法）放 skills，实测约 2855 字，离 4000 还有余量。

**两个会白烧一轮的细节：**

1. `memory.correct` 的 `patch.summary`（块摘要）有 **60 字上限**，超了报的是「**技能**一句话描述超过 60 字」，明明改的是 rules 也这么报——不是 bug 提示错，是同一个字段校验，按 60 字砍就行。
2. **字数一定要先量再写**。做法：草稿写进一个临时 `.md`，`(Get-Content -Raw).Trim().Length` 量一次，超了就删句子再量；直接塞进 `memory.correct` 发现超上限，等于把 2000 字的正文白传一遍。实测 2149 → 砍到 1976。

---

## 二、转移记忆与人格卡

```bash
# 角色包 → 本地库：persona 进 L1，记忆记录逐条变成 L2 卡
dsh-memlattice bridge import

# 覆盖已有 persona（默认跳过已存在的）
dsh-memlattice bridge import --persona

# 反向写回角色包，写前整个目录先备份
dsh-memlattice bridge export

# 只渲染注入用的记忆文件，不写库
dsh-memlattice bridge sync --query "主人是谁"
```

细节：

- persona 超过 2200 字会截断，末尾留原文位置
- 映射存在 `~/.memlattice/surfcore-map.json`，重复 import 会跳过已导过的
- 角色目录默认读 `~/.dsh/surfcore/characters/current.json` 指向的那个，可用 `--char <目录>` 指定
- import 会给 persona 正文自动加一个分类小标题（实测「【性格与表达】」），后面手改 persona 时别以为是别人写的

### `bridge import` 常常只搬进 persona

它读的是 `memory/memory-card.json` 的 `records[]`。**这个文件经常不存在**（SurfCore 的合并没跑过，或记忆仍在别的容器里），于是输出 `记录：0 条`，只有 persona 落地。这是正常现象，**不要为了让它搬记录去补造 `memory-card.json`**。

真正的记忆散在这些地方，import 不认：

| 文件 | 内容 | 建议 |
|---|---|---|
| `bili/bili-memory.md` + `bili-memory-brief.md` | B站 账号身份、口味、习惯 | 合成 **1 张卡**（`source: external`） |
| `memory/vector-memory.jsonl` | 逐条 QQ 消息（含自己说的） | 不要逐条成卡，噪声大 |
| `memory/memory-inbox.jsonl` | 收件队列原文 | 同上，合成一张「近期往来」即可 |

做法是 `memory.write` 手工补：`messages` 放原文，`card.summary` 写 40–200 字结论，`keywords` 给 1–3 个实词，`source` 用 `external` 的卡不会进 L1。两张卡用 `memory.write.batch` 一次提交（每组可以带不同的 `source`），比调两次省一轮。

### 关键词就是检索入口（两次都栽在同一件事上）

写完**一定要跑一次 `memory.recall` 验证**，而且要拿用户真会说的那句去测，不能只测关键词本身：

| 查询 | 结果 | 怎么办 |
|---|---|---|
| `主人是谁` + 关键词 `主人/木子/单字试探` | 0.82 强命中 | ✅ |
| `B站那个号是我吗` + 关键词 `B站账号/口味偏好` | **完全没命中**（只回退到「最近记录」） | 分词没把「B站那个号」对到「B站账号」 |
| 同上，关键词补成 `B站 / B站账号 / 口味` | 0.805 强命中 | ✅ |

规律：**专名要同时放长写法和短词**（`B站账号` 命中资料卡，`B站` 命中口语）。同理「主人」比「主人私聊」管用。别用「近期往来」「单字试探」这种自造词当唯一关键词。

### 卡片字段的硬限制

- `card.summary`：40–200 字，超下界/上界都报错；
- `card.keywords`：1–3 个（最多 8），每个 **2–12 字**，不许有「好的」「感觉」这类碎片；
- `entities`：≤5 个；
- 卡片 `source` 在 **messages 级**（`memory.write` 的参数），不是 card 字段，`batch` 里每组各带各的。

---

## 三、⚠️ QQ 桥接的工具白名单（不改，前两步全白做）

**这是整个迁移最关键、也最容易被漏掉的一步。**

SurfCore 的 QQ preset 挂了一个执行期守卫，只放行三个 MCP 前缀：

```js
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]
```

`mcp__memlattice__*` 不在里面，于是模型看到工具、唤醒提示也写着「去 `memory.start` 取」，一调用就被拒：

```
工具 "mcp__memlattice__memory_start_xxx" 不在 QQ 桥接白名单内，已拒绝
（仅允许 QQ MCP 工具与无害模型侧工具）
```

补一行：

```js
  'mcp__memlattice__',   // 纯本地 SQLite，无 shell/文件/网络执行面
```

### 只有一个文件要改

**唯一权威实现**是 `plugins/surfcore/qq-tool-restrict.mjs`。`dsh/agent-presets/qq-chat/`、`dsh/agent-presets/qq-chat-v2/` 下那两个同名文件只是 re-export 壳（`export * from '../../../plugins/surfcore/qq-tool-restrict.mjs'`），改它们**一点用都没有**——别在这里白改一次、再去核实第二次。

### 改完只重启桥接＝没改

guard 由 preset 插件在 **DSH 主进程**里加载，桥接进程里根本没有这段代码。所以：

| 重启了什么 | 白名单生效？ |
|---|---|
| 只重启 QQ 桥接 | ❌ 仍被拒（实测：15:12 改文件 → 15:15 唤醒仍报白名单） |
| 重启 DSH 主进程 | ✅（实测：重启后 15:18:11 `memory_start` 返回 `ok: true`） |

这一条只能用户做（agent 重启 DSH 等于自杀）。所以**计划里从一开始就要留这一次重启**。

验证方式不是看日志猜：看 `surfcore/state/tool-calls.jsonl` 里 `memory_start` 的 `ok` 是否变成 `true`。

顺带：这份名单是**常量不是配置**，任何新加的 MCP server 都要回来手工放行——「工具出现在 schema 里」绝不代表能执行，`tools.guard` 才是边界。

### 补丁只换了 base，没换分支文案

`prompt-off` 替换的是 `buildWakePromptV2` 里的 `base` 拼装行；`reason === 'bootstrap'` 分支的尾巴仍写着「请先调用 `qq_get_prompt` 查看角色…」，而 `qq_get_prompt` 在屏蔽后是停用的。模型会先按顶部那句去调 `memory.start`（正常），但偶尔会照分支去调一个死工具，白烧一轮。

顺手改掉（`bridge.js` 里 `if (reason === 'bootstrap')` 那一行的 return）：

```js
人格、记忆与本次的行为规则请先调用 mcp__memlattice__memory.start 获取（qq_get_prompt 已停用，不要再调用它）；
```

注意：`/api/socialV2/prompt` 的 `enabledTools` 里**仍然会列出 `qq_get_prompt`**（那是工具开关，不是提示词），别以为屏蔽失败。

---

## 四、屏蔽提示词

关掉 SurfCore 在会话开头拼的人格与记忆，改成让 AI 自己去 MCP 取。

```bash
dsh-memlattice prompt-off apply    # 打补丁 + 建开关
dsh-memlattice prompt-off status   # 看补丁、开关、进程是否加载
dsh-memlattice prompt-off revert   # 还原
```

它做两件事：

1. 给 `surfcore/src/bridge.js` 的四个拼装点打补丁
2. 创建 `surfcore/state/prompt-off.flag`

**开关是文件不是环境变量**——`setx` 只写注册表，对已经运行进程无效，这个坑踩过。要恢复注入，删掉那个 flag 文件即可，不用动代码。

补丁生效后，QQ 唤醒提示只剩三段：会话令牌、此刻状态、当前唤醒配置，外加一句「去 `memory.start` 取」。其余全部去掉。

**`status` 会对比两个时间**：`bridge.js` 的修改时间与桥接进程的启动时间。进程更旧就说明还在跑旧代码，必须重启 QQ 桥接。

### 一次调用就能验收 prompt-off（不必真唤醒）

```powershell
$tok = (Get-Content C:\Users\<你>\surfcore\state\console-token -Raw).Trim()
$p = Invoke-WebRequest "http://127.0.0.1:3100/api/socialV2/prompt?key=private:<主人QQ>" `
       -Headers @{ 'x-console-token' = $tok } -UseBasicParsing
($p.Content | ConvertFrom-Json).role.hint
```

判定：`role.hint` 是「调用 `mcp__memlattice__memory.start` 获取」；再顺手看返回里 `memoryCard` 为空、`memory` 为空。这条**不用唤醒模型**，比发消息/手动唤醒省一整轮 token。

### 控制台令牌对不上会全量 401

桥接控制台（默认 `127.0.0.1:3100`）用 `x-console-token` 鉴权，MCP 代理优先取 `surfcore/config.json` 的 `consoleToken`，取不到才回退 `state/console-token`。两边不一致时**所有** QQ 工具都报 `未授权：请提供控制台访问令牌`（连 `qq_read` / `qq_mark_read` 一起挂），看起来像"QQ 坏了"。

诊断（不用猜，直接打接口）：

```powershell
# 两个候选 token 各打一次 /api/status，200 的那个才是桥接认的
Invoke-WebRequest "http://127.0.0.1:3100/api/status" -Headers @{ 'x-console-token' = '<config.json 里的>' } -UseBasicParsing
Invoke-WebRequest "http://127.0.0.1:3100/api/status" -Headers @{ 'x-console-token' = '<state/console-token 里的>' } -UseBasicParsing
```

处理：把两边写成同一个值（一般是让 `state/console-token` 跟随 `config.json`）。桥接每次重启都可能重生成，所以**排查任何 QQ 工具失败之前，先确认是不是刚重启过**。

---

## 五、只清人格与记忆文件

不关 MCP、不改代码，只把 SurfCore 那几份文件清空：

```bash
dsh-memlattice detach disable   # 备份后清空，含 bili/ 与 roles/
dsh-memlattice detach status    # 看现状
dsh-memlattice detach restore   # 原样还原
```

涉及文件：`persona.md`、`persona.full.md`、`memory-card*.md`、`bili-memory*.md`、`memory-inbox.jsonl`，以及 `roles/` 下的示例角色卡（改名 `.off`，不删）。

备份按原相对路径存在 `.detach-backup/` 下。注意 `detach status` 报的是**字数**（persona 191 字），文件是 497 字节，别拿文件大小判断「有没有清空」。

### 三个必须知道的偏差

1. **「已关闭 memoryCard.enabled」是空话**。脚本改的是 `~/.dsh/surfcore/config.json`（统一配置层），这台机器上**根本没这个文件**，`existsSync` 判断跳过，但那行 `console.log` 是无条件打印的。真实配置在 `surfcore/config.json`，里面连 `memoryCard` 这个键都没有。要让 SurfCore 停写记忆卡，得自己去那边加。
2. **`bili-memory*.md` 会自己长回来**。`biliBridge.memory.refreshIntervalMs` 默认 600000（10 分钟），下一轮同步就把 423 字简报写回去。所以 detach 对 B 站这两份是**临时**的，真正挡住注入的是 `prompt-off` 补丁。
3. **`roles/*.md` 改名 `.off` 后，QQ 里 `/role 小咪` 切不动了**。人格统一由 MemLattice 的 persona 块提供；要保留切角色就得 `detach restore` 或用 MemLattice 侧多写几份 persona。

结论：detach 是**补丁丢了的兜底**（SurfCore 升级冲掉 `bridge.js` 时，至少没人格可注入），不是主手段。主手段永远是 `prompt-off`。

---

## 六、控制台 API 速查（验证和救火都靠它）

`state/console-token` 就是令牌；**POST 必须带 `Content-Type: application/json`**，否则返回 415（`readBody` 直接按 JSON 解析）。

```powershell
$tok = (Get-Content C:\Users\<你>\surfcore\state\console-token -Raw).Trim()
$H   = @{ 'x-console-token' = $tok; 'Content-Type' = 'application/json' }
```

| 目的 | 调用 |
|---|---|
| 桥接活着吗、什么模式 | `GET /api/status` |
| 提示词被屏蔽成什么样（不唤醒） | `GET /api/socialV2/prompt?key=private:<QQ>` |
| 手动唤醒一次（验收用） | `POST /api/socialV2/wake` body `{"key":"private:<QQ>","reason":"admin"}` |
| 重启桥接 | `POST /api/restart` body `{}` |
| 聊天记录/工具日志 | `state/tool-calls.jsonl`、`state/bridge.log` |

### `/api/restart` 是个陷阱（实测掉线一次）

它只做一件事：**自己 `process.exit(0)`**。如果桥接不是由 `start.bat` 的守护窗口拉起来的（比如 agent 用 `Start-Process` 直接起的 node），退出后**没有任何东西会再拉起它**——QQ 当场下线，`bridge.lock` 也一起消失。

重启桥接的稳妥顺序：

1. `POST /api/restart`（优雅落盘，推荐）；
2. 等 8–10 秒，`netstat -ano | findstr :3100` 看有没有 LISTENING；
3. **没有就手动起**（`start.bat` 会自己跑 `node src/bridge.js` 并带 5 秒重启循环）：

   ```powershell
   Start-Process -FilePath "C:\Windows\System32\cmd.exe" `
     -ArgumentList '/c','start.bat' -WorkingDirectory "C:\Users\<你>\surfcore"
   ```

   再等 10 秒复查。注意：从 DSH 的 shell 里起桥接会继承 `DSH_WEB_URL`，桥接会跳过端口探测——所以要它重新探测，就从一个**不继承该变量**的终端起；
4. 起完 `GET /api/status` 确认 `mode=reserved2`、`role` 是想要的角色。

### 验收只看一处

```powershell
Select-String C:\Users\<你>\surfcore\state\tool-calls.jsonl -Pattern 'memory_start' | Select-Object -Last 2
```

等两行：`"type":"call"` + `"type":"result"`，且 `"ok":true`。`ok:false` 且 error 里带「不在 QQ 桥接白名单内」= DSH 还没重启（第三节）。

---

## 顺序建议

1. 看一眼 `config.json`（admin / tokenGuard / allow / wake）——决定 rules 抽哪些段
2. `bridge import` —— 先把 persona 搬进来
3. `memory.write.batch` 补卡 —— B站记忆 + 近期往来
4. `memory.correct` 写 rules / skills —— 注意 2000 / 4000 与 60 字摘要
5. **改 QQ 工具白名单** —— 只改 `plugins/surfcore/qq-tool-restrict.mjs`
6. `detach disable` + `prompt-off apply` —— 最后才关它的注入（顺手改掉 `bootstrap` 分支里的 `qq_get_prompt`）
7. 重启桥接 → **让用户重启 DSH** → 一次手动唤醒验收

顺序反了会有一段时间「旧记忆没了、新记忆也取不到」，而那段时间 QQ 还在正常收消息——等于在裸奔。

---

## 一次跑完，别来回问

这套动作最费时间的不是命令本身，是**每一步都停下来查一次状态**。按下面这份清单执行，只在中途需要人决策的地方弹一次窗（第 0 节，含「最后要重启 DSH」），其余一口气做完：

```powershell
$node = "C:\Users\<你>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$cli  = "C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-memlattice\bin\cli.mjs"

# 1) 一次看清现状（两个命令一次敲完，别分两轮）
& $node $cli detach status
& $node $cli prompt-off status

# 2) 搬 persona（幂等；要覆盖加 --persona）—— 需要放宽权限（见零点五）
& $node $cli bridge import

# 3) 补卡：memory.write.batch 两张（B站记忆 source=external + 近期往来）
# 4) 写 rules / skills：memory.correct；先把草稿落盘量字数（≤2000 / ≤4000，summary ≤60）
# 5) 放行白名单：改 plugins/surfcore/qq-tool-restrict.mjs（只此一个文件）
# 6) 关注入：这两条一次放宽权限跑完
& $node $cli detach disable
& $node $cli prompt-off apply

# 7) 重启桥接（第六节），然后等用户重启 DSH，再：
#    - 手动唤醒一次，看 tool-calls.jsonl 里 memory_start 的 ok=true
#    - memory.recall 能强命中新写的卡
```

省调用的几个要点：

- `memory.start` 一次就能看清 persona / rules / 经验索引三块，**不要**再分别去读块、也不要反复 start 刷（每次都会写一条 `mem_injection` 快照）。改完 L1 块后必须再 start 一次，否则本轮还按旧块办事。
- 规则段用一次 grep 抽（第一节），不要在 97 万字节的 `bridge.js` 里翻。
- `detach status` 和 `prompt-off status` 各跑一次就够，两个输出合起来就是全部现状；`doctor` 的「MCP 配置行已写入」FAIL 是**误报**（bundle 通过 `package.json` 的 `dsh.bundle.patch` 提供 patch，不写 profile 的 `cordis.patch.yml`），别为它反复排查。
- 验证阶段只跑两条：`memory.recall`（卡通不通）+ 看 `tool-calls.jsonl` 末尾（QQ 侧能不能调）。通了就收工。
- **沙箱下进程枚举经常是空的**：`Get-CimInstance Win32_Process` 可能返回空、`Get-Process -Id <别人的PID>` 也可能 not found。判断「谁在跑」用 `netstat -ano | findstr :3100` + `prompt-off status` 给的 PID/启动时间，别在 WMI 上耗几轮。

---

## 注意事项

- **SurfCore 升级会覆盖 `bridge.js`**，补丁消失，需要重跑 `prompt-off apply`；升级也可能重置 `qq-tool-restrict.mjs` 的白名单，放行要重做
- `prompt-off` 只对**独立运行的 bridge.js 进程**生效；如果 QQ 走的是 DSH 插件内置路径，补丁点不在这里
- 升级 SurfCore 后角色目录可能变（`characters/char-xxxx`），`import` 前先确认 `current.json` 指向的是想要的那个
- 组合包自带的 `cordis.patch.yml` 固定 `npx dsh-memlattice@0.1.8 serve`，而包本身可能是 0.1.9：schema 相同可以先跑，但两边不一致迟早踩，升级时顺手对齐
- 迁移完成后别再让 SurfCore 边写边迁：它仍会写 `vector-memory.jsonl` / `bili-memory.md`，这些**不会自动进** MemLattice。要么定期重跑 `bridge import`，要么在 rules 里加一条「聊到值得记的就 `memory.write` 收卡」，让 QQ 侧自己维护
- **迁移后第一轮醒来，模型可能自己把唤醒配置改成 `mode=active` + `anyMessage=true` + 概率 1**（2026-11-16 实测），等于每条消息都醒、每轮都烧 token。要是不想要，去控制台 `POST /api/socialV2/wake-config` 改回 `diving` + 概率 0.05。
- **想看库里到底进了什么**：`dsh-memlattice web [端口]`（默认 8787，和 `serve` 同一份库）。注意它是**前台进程**，被工具调用结束就会杀掉，要常驻得用 `Start-Process ... -WindowStyle Hidden` 自己拉起；令牌取 `MEMLATTICE_TOKEN`（默认 `dev-token-change-me`），监听 `0.0.0.0`（局域网可达），只是自己看就换掉默认令牌。

---

### ⚠️ 用完任何工具都必须重启 DSH 应用或服务

**这一步不做，前面所有改动都只写进了文件，运行的还是内存里的旧代码。**

具体重启哪个，看改的是什么文件：

| 改的是 | 重启 |
|---|---|
| `surfcore/src/bridge.js` | QQ 桥接（`停止QQ机器人-全部.bat` → `start.bat`） |
| `surfcore/plugins/surfcore/*.mjs`（含工具白名单） | **DSH 主程序**——重启桥接没用 |
| `surfcore/dsh/agent-presets/*` | DSH 主程序，且要先重新跑 `setup-dsh.mjs` 生成 patch |
| `~/.dsh/profiles/*/cordis.patch.yml` | DSH 主程序 |
| MemLattice 的 `dist/`（`npm run build` 之后） | DSH 主程序（MCP 子进程由它拉起） |

**2026-11-16 两轮实测过的坑**：`qq-tool-restrict.mjs` 加完 `mcp__memlattice__`，只重启 QQ 桥接，调用仍被拒。原因是这个 guard 由 preset 插件在 **DSH 主进程**里加载，桥接进程里根本没有这段代码：

```
15:06:47  DSH 主进程启动（加载 guard）
15:12:50  qq-tool-restrict.mjs 改完
15:15:04  手动唤醒 → memory_start 被旧 guard 拒
15:15:xx  QQ 桥接重启（PID 10824）← 只重启了这个，没用
15:17:xx  用户重启 DSH
15:18:11  新会话 → memory_start ok:true  ✅
```

判断代码有没有真的换掉，别猜——比时间，而且要挑**看得见**的手段：

```powershell
# 改完的文件
(Get-Item C:\Users\<你>\surfcore\plugins\surfcore\qq-tool-restrict.mjs).LastWriteTime

# 真正在跑的进程：先看端口
netstat -ano | findstr ":3100 :3080"
# 再用 PID 取启动时间（沙箱下 Get-CimInstance 可能整个返回空，别指望它）
Get-Process -Id <PID> | Select-Object Id, ProcessName, StartTime
# 桥接这侧还有现成的：prompt-off status 会直接打印 PID 与启动时间
```

**进程启动时间晚于文件修改时间，才算加载了新代码。** 只有桥接晚了、DSH 主进程还早，就说明白名单这类插件代码没生效——继续重启 DSH 直到它变晚。这一条**只能用户点**，agent 重启 DSH 就是关掉自己。

改完不重启的话，`prompt-off status` 会显示「✓ 进程晚于补丁」，但它只比对**桥接**进程，对 preset 插件无效，别被这行字骗了。
