/* eslint-disable no-console */
/**
 * 生成演示库：data/demo.db。内容独立于主库，可随时删掉重建。
 * 用途是让图谱、列表、记忆检索页有真实的形状，录屏与截图时不至于空着。
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createTokenizer } from '../src/core/tokenizer.js';
import type { Ctx } from '../src/services/context.js';
import { bootstrap } from '../src/db/bootstrap.js';
import { closeSql, createSql } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrate.js';
import { recall, write } from '../src/services/memory.service.js';

interface Seed {
  scope: string;
  intent: '查状态' | '求推荐' | '排错' | '决策' | '学习' | '信息同步' | '情感交流';
  keywords: string[];
  entities: string[];
  summary: string;
  turns: Array<[string, string]>;
}

const PERSONA = `先给结论，再补要点；不确定就明说，不硬猜。
偏好简洁直白的表达，反感客套和形容词堆砌。
涉及取舍时列两三个方案与代价，由我拍板。`;

const RULES = `事实类问题先取证再下结论，本地命令只算证据之一。
改代码前先搜清关联面；确认没有调用方的旧实现直接删，不留兼容层。
注释只写原因，不写「改了什么」。`;

const SKILLS = [
  {
    slot: 'skill:1',
    summary: '涉及数据库改动时，先确认两端是否都能跑',
    content: `项目同时支持 SQLite 与 PostgreSQL，任何 SQL 改动都要在两端验证。

判据：
1. 数组参数用 IN (\${ids}) 展开，不要 ANY(ARRAY[...])；
2. 批量插入用 values(rows)，不要 unnest；
3. 日期一律作为参数传入，SQL 里不写 now() 或 interval；
4. 确实需要分叉时用 dialect 判断，并在注释里写清原因。

验证方式：npm run smoke:sqlite 与 npm run smoke 都跑一遍。`,
  },
  {
    slot: 'skill:2',
    summary: '复盘时先找反例，再找解释',
    content: `复盘一件事时，先问「什么证据能推翻我现在的结论」，再去收集。

反例优先的原因：人天然会挑支持自己的证据，先找反例能抵消这个偏差。
如果找不到反例，结论才值得写进记忆。`,
  },
];

const SEEDS: Seed[] = [
  {
    scope: 'demo-work',
    intent: '决策',
    keywords: ['SQLite', '数据库', '部署'],
    entities: ['MemLattice', 'PostgreSQL'],
    summary:
      '记忆库确定默认 SQLite、PostgreSQL 可选：SQLite 让单机用户零依赖跑起来，PG 留给需要分区表与向量检索的部署，切换只改环境变量。',
    turns: [
      ['user', '要不要干脆只支持 SQLite，省得维护两套？'],
      ['assistant', '不建议。现有 PG 部署要迁移，而且分区表和 pgvector 在 SQLite 没有替代。双后端多花的成本主要在查询改写，不在运行时。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '排错',
    keywords: ['踩坑', 'SQLite', '参数编码'],
    entities: ['postgres.js'],
    summary:
      '踩坑：把 JSON 字符串直接当参数写进 jsonb 列，会被二次编码存成字符串标量，读回来是字符串不是对象。改成传原始对象给驱动即可。',
    turns: [
      ['user', '为什么候选的 payload 读出来是字符串？'],
      ['assistant', '写进去的时候传了 JSON.stringify 的结果，驱动又编码了一次。改成传对象本身，让驱动决定怎么编码。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '排错',
    keywords: ['踩坑', '部署', '安装脚本'],
    entities: ['git', 'bash'],
    summary:
      '踩坑：Windows 下提交的 sh 脚本被转成 CRLF，在 Linux 上 shebang 直接报错。加 gitattributes 固定 sh 用 LF、ps1 用 CRLF 之后解决。',
    turns: [
      ['user', '安装脚本在服务器上跑不了。'],
      ['assistant', '大概率是 CRLF。加一条 .gitattributes 把 *.sh 固定成 eol=lf，重新检出即可。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '决策',
    keywords: ['许可', '非商业', 'PolyForm'],
    entities: ['PolyForm', 'MIT'],
    summary:
      '许可最终选 PolyForm Noncommercial 1.0.0：SPDX 收录、专为软件写、禁止商业用途，衍生必须沿用同一许可，能挡住改名换证再发布。',
    turns: [
      ['user', '想禁止商用，但也不想自己写许可条款。'],
      ['assistant', '用 PolyForm Noncommercial。它允许非商业使用与修改，禁止商业用途，且要求衍生沿用同一许可，比手写靠谱。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '学习',
    keywords: ['召回', '记忆', '图扩散'],
    entities: ['Personalized PageRank'],
    summary:
      '召回用子图上的 Personalized PageRank 扩散：种子词权重高、沿边衰减，两跳为止。两跳以上会把整张词表都拉进来，等于没有区分度。',
    turns: [
      ['user', '为什么只扩散两跳？'],
      ['assistant', '三跳之后子图基本连通了，PPR 分数趋同，排序退化成按热度排。两跳能覆盖同义与共现，又不至于失控。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '决策',
    keywords: ['预算', '召回', '注入'],
    entities: ['token'],
    summary:
      '召回设注入预算硬上限：默认 1200 token，超了直接拒绝而不是截断。每个被丢弃的条目都要带原因，事后能解释「为什么当时没给模型」。',
    turns: [
      ['user', '为什么不干脆多注入一点，反正上下文够大？'],
      ['assistant', '够大不等于该塞满。注入越多，噪声越多，而且成本随轮次线性涨。给硬上限并记录丢弃原因，才能定位召回质量问题。'],
    ],
  },
  {
    scope: 'demo-life',
    intent: '信息同步',
    keywords: ['作息', '开会', '工作时间'],
    entities: [],
    summary:
      '作息偏晚：通常十点后进入状态，下午两点到五点是深度工作时间，这段时间尽量不安排会议，急事用消息而不是电话。',
    turns: [
      ['user', '记住我的作息，别在早上九点给我排会。'],
      ['assistant', '记下了：十点后进状态，下午两点到五点是深度工作时段，不排会。'],
    ],
  },
  {
    scope: 'demo-life',
    intent: '求推荐',
    keywords: ['咖啡', '偏好', '口粮'],
    entities: [],
    summary:
      '喝浅烘手冲，不加糖不加奶；对酸度容忍度高，讨厌焦苦味。日常口粮选水洗处理的埃塞，价格敏感度中等，一包两周。',
    turns: [
      ['user', '推荐个日常喝的口粮豆。'],
      ['assistant', '按你的口味偏浅烘水洗埃塞，果酸明显、尾段干净的那种，别选深烘拼配。'],
    ],
  },
  {
    scope: 'demo-life',
    intent: '情感交流',
    keywords: ['压力', '项目', '状态'],
    entities: [],
    summary:
      '最近因为项目收尾压力偏大，主要来自「想一次做到位」的自我要求。有效的缓解方式是先做出能跑的粗糙版本，再迭代，而不是反复权衡。',
    turns: [
      ['user', '最近有点烦，总觉得东西没做完。'],
      ['assistant', '听起来是完成标准定得太高。先把能跑的最小闭环交付出去，剩下的按反馈迭代，比在脑子里反复推演省力。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '信息同步',
    keywords: ['界面', 'Vue', '组件'],
    entities: ['Vue 3', 'Tailwind'],
    summary:
      '管理端统一用 Vue 3 + Tailwind，组件走 shadcn-vue 风格；页面结构按「一个主区域 + 次级说明」组织，反感碎片化小窗口堆叠。',
    turns: [
      ['user', '设置页别做成一堆小卡片，看着乱。'],
      ['assistant', '改成左侧分组导航 + 右侧单列长表单，分组之间用间距区分，不加装饰性分割线。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '排错',
    keywords: ['SQLite', '踩坑', 'UPDATE'],
    entities: ['SQLite'],
    summary:
      '踩坑：PostgreSQL 允许 UPDATE 表别名（UPDATE term t SET ...），SQLite 不支持，必须写成 UPDATE term SET ... WHERE term.id = ...。',
    turns: [
      ['user', 'SQLite 报 near "t" 语法错误。'],
      ['assistant', 'UPDATE 后面不能带别名。去掉 t，把 WHERE 里的 t.id 改成 term.id。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '学习',
    keywords: ['记忆', '预算', '常驻层'],
    entities: ['L1', 'L2'],
    summary:
      '记忆分层的关键不是分几层，而是每层的注入成本可控：常驻层只放索引与规则，正文按需下钻，事件卡按预算竞争名额，原文只在明确要证据时取。',
    turns: [
      ['user', '分层到底解决什么问题？'],
      ['assistant', '解决注入量随历史增长的问题。每层都有固定的预算上限，用不到的内容不下发，代价是偶尔要多一跳才能拿到正文。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '决策',
    keywords: ['召回', '记忆', '向量'],
    entities: [],
    summary:
      '向量召回定为可选增强而不是主路径：没有 embedding 时关键词与词图照常工作，宁可召回率低一点，也不让「必须配模型」成为安装门槛。',
    turns: [
      ['user', '不接 embedding 是不是效果差很多？'],
      ['assistant', '同义词覆盖会弱一些，但中文场景下关键词加词图已经能覆盖大部分。把 embedding 做成可选，安装门槛才是零。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '信息同步',
    keywords: ['记忆', '生命周期', '归档'],
    entities: [],
    summary:
      '每日巡检负责降温与清理：冷卡压成骨架卡并断开原文，原文满一年归档、满两年进回收站，回收站保留七天。所有任务分批执行，可中断续跑。',
    turns: [
      ['user', '巡检会不会误删东西？'],
      ['assistant', '不会直接物理删除。先进回收站，七天内在管理端能恢复；骨架化也只是压缩摘要并断开原文引用，卡本身还在。'],
    ],
  },
  {
    scope: 'demo-life',
    intent: '信息同步',
    keywords: ['家人', '生日', '提醒'],
    entities: [],
    summary:
      '家里人过生日习惯提前一周准备礼物，不喜欢临时买东西；礼物偏好实用类，反感纯装饰摆件。',
    turns: [
      ['user', '记一下，给家里买东西别买摆件。'],
      ['assistant', '记下了：提前一周准备，优先实用类，不买纯装饰摆件。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '排错',
    keywords: ['MCP', '踩坑', 'stdio'],
    entities: ['MCP'],
    summary:
      'stdio 模式下 stdout 只能走协议数据，任何调试输出都必须写 stderr。曾经把日志打到 stdout，导致客户端解析失败且没有任何报错提示。',
    turns: [
      ['user', '客户端连上了但工具列表是空的。'],
      ['assistant', '检查 stdout。如果有非 JSON 的输出混进去，握手就废了，工具列表自然空。日志一律走 stderr。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '决策',
    keywords: ['README', '文档', '定位'],
    entities: [],
    summary:
      'README 按「能跑起来」排序而不是按架构排序：先给一条命令能跑起来的路径，再讲机制。内部需求编号与验收表不进 README，那是给验收人看的。',
    turns: [
      ['user', 'README 要不要把需求编号也写上？'],
      ['assistant', '不用。用户关心的是三行命令能不能跑起来、出了问题去哪查。需求编号放 docs 里，别放在门面上。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '学习',
    keywords: ['记忆', '召回', '热度'],
    entities: [],
    summary:
      '热度只由行为驱动：召回、下钻、被新卡引用、人工编辑各给不同增量，再按半衰期折算。不做定时全表刷新，避免「久未访问但很重要」的卡被系统性压低。',
    turns: [
      ['user', '为什么不用定时衰减？'],
      ['assistant', '定时刷新会把「没人访问」和「不重要」混为一谈，而且整表扫描的代价随数据量涨。写时折算只算被碰到的那几行。'],
    ],
  },
  {
    scope: 'demo-work',
    intent: '信息同步',
    keywords: ['界面', '记忆', '图谱'],
    entities: ['G6'],
    summary:
      '图谱改成同心环：常驻层在圆心，关键词内环，记忆卡外环。按卡数过滤关键词，未命中词的卡统一挂到「其他」，保证每张卡都能看到。',
    turns: [
      ['user', '图太乱了，节点挤在一起。'],
      ['assistant', '改同心环布局：圆心常驻，中间关键词，外圈卡片，半径按节点数自动算。再按「出现卡数」过滤低频词。'],
    ],
  },
];

async function main(): Promise<void> {
  const dbPath = resolve(process.cwd(), 'data', 'demo.db');
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }

  process.env.DB_DIALECT = 'sqlite';
  process.env.SQLITE_PATH = dbPath;

  const cfg = loadConfig();
  const sql = createSql(cfg);
  const tokenizer = await createTokenizer();

  try {
    await migrateUp(sql, cfg.migrationsDir);
    const userId = await bootstrap(sql, cfg);
    const ctx: Ctx = { sql, cfg, tokenizer, now: () => new Date(), cachedUserId: userId };

    await sql`
      UPDATE mem_block SET content = ${PERSONA}
      WHERE user_id = ${userId} AND label = 'persona'`;
    await sql`
      UPDATE mem_block SET content = ${RULES}
      WHERE user_id = ${userId} AND label = 'rules'`;

    for (const [index, skill] of SKILLS.entries()) {
      await sql`
        INSERT INTO mem_block (user_id, label, slot, summary, content, char_limit, read_only, source)
        VALUES (${userId}, 'skills', ${skill.slot}, ${skill.summary}, ${skill.content}, 4000, false, 'human')
        ON CONFLICT DO NOTHING`;
      void index;
    }

    let written = 0;
    for (const seed of SEEDS) {
      const result = await write(ctx, {
        messages: seed.turns.map(([role, content]) => ({ role, content })),
        close: true,
        scope: seed.scope,
        card: {
          summary: seed.summary,
          intent: seed.intent,
          keywords: seed.keywords,
          entities: seed.entities,
          category: seed.scope === 'demo-life' ? 'person' : 'general',
        },
      });
      if (result.card_id !== null) written += 1;
    }

    // 制造热度差异：被召回过的卡与词会亮一些，图谱才有层次
    for (const query of ['部署方案与数据库选型', '召回预算怎么定', '踩过的坑', '作息和口味偏好']) {
      await recall(ctx, { query });
    }

    const stats = await sql<Array<{ cards: number; terms: number; edges: number; raws: number }>>`
      SELECT
        (SELECT count(*) FROM mem_card WHERE deleted_at IS NULL) AS cards,
        (SELECT count(*) FROM term WHERE deleted_at IS NULL) AS terms,
        (SELECT count(*) FROM term_edge) AS edges,
        (SELECT count(*) FROM mem_raw) AS raws`;
    const row = stats[0];
    console.log(`演示库已生成：${dbPath}`);
    console.log(`  卡片 ${row?.cards ?? 0} / 关键词 ${row?.terms ?? 0} / 词边 ${row?.edges ?? 0} / 原文 ${row?.raws ?? 0}`);
    console.log(`  写入成功 ${written} 条`);
    console.log('');
    console.log('用演示库启动：');
    console.log('  PowerShell:  $env:SQLITE_PATH="./data/demo.db"; npm start');
    console.log('  bash:        SQLITE_PATH=./data/demo.db npm start');
  } finally {
    await closeSql(sql);
  }
}

main().catch((err: unknown) => {
  console.error('生成演示库失败：', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
