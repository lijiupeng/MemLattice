/* eslint-disable no-console */
/**
 * 真库冒烟：用嵌入式 PostgreSQL 跑通写入 → 浓缩 → 召回 → 下钻 → 治理 → 生命周期。
 * 运行：npx tsx scripts/smoke.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig } from '../src/config.js';
import { closeSql, createSql } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrate.js';
import { bootstrap } from '../src/db/bootstrap.js';
import { createTokenizer } from '../src/core/tokenizer.js';
import { correct, expand, forget, listTrash, recall, restoreSnapshot, restoreSoft, write } from '../src/services/memory.service.js';
import { graphData, listAudit, listCards, approveCandidate, listCandidates } from '../src/services/governance.service.js';
import { graphRadial } from '../src/services/graph.service.js';
import { runPatrol } from '../src/services/lifecycle.service.js';
import { callTool, MCP_TOOLS } from '../src/api/mcp.js';
import { isAppError } from '../src/core/errors.js';
import type { Ctx } from '../src/services/context.js';
import { freePort } from './ports.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function expectError(name: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    check(name, false, `未抛出 ${code}`);
  } catch (err) {
    const actual = isAppError(err) ? err.code : 'E_OTHER';
    check(name, actual === code, actual === code ? undefined : `实际 ${actual}`);
  }
}

const STOCK_MESSAGES = (i: number): Array<{ role: string; content: string }> => [
  {
    role: 'user',
    content: `第${i}次讨论：股票行情怎么样，新能源板块和算力方向选哪个好？帮我推荐一个方向。`,
  },
  {
    role: 'assistant',
    content: `第${i}次结论：当前股票行情缩量，新能源板块资金流出，算力方向更强。建议把新能源仓位减到三成，保留底仓，优先算力。`,
  },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'memlattice-pg-'));
  const port = await freePort(55440);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: () => {},
    onError: (message) => console.error('[pg]', message),
  });

  let sql: ReturnType<typeof createSql> | null = null;

  // Ctrl+C 时释放数据库与集群，避免残留 postgres 占端口
  const shutdown = async (code: number): Promise<void> => {
    if (sql) await closeSql(sql).catch(() => {});
    await pg.stop().catch(() => {});
    process.exit(code);
  };
  process.once('SIGINT', () => void shutdown(130));
  process.once('SIGTERM', () => void shutdown(143));

  try {
    console.log('启动嵌入式 PostgreSQL ...');
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('memlattice');
    process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/memlattice`;
    // 审核链路用例需要名单生效：显式配置，不依赖代码默认值
    process.env.BLOCK_APPROVAL_LABELS = 'rules,persona';

    const cfg = loadConfig();
    sql = createSql(cfg);
    const applied = await migrateUp(sql, cfg.migrationsDir);
    check('迁移可执行', applied.length >= 1, applied.join(','));

    const userId = await bootstrap(sql, cfg);
    const ctx: Ctx = {
      sql,
      cfg,
      tokenizer: await createTokenizer(),
      now: () => new Date(),
      cachedUserId: userId,
    };
    check('分词器可用', Boolean(ctx.tokenizer.name), ctx.tokenizer.name);

    // ---------------------------------------------------------- A. L1 与写入
    await correct(ctx, {
      userId,
      target: { type: 'block', label: 'rules' },
      patch: { content: '回答前先给结论；不确定时明说不确定。' },
      actor: 'human',
    });
    await correct(ctx, {
      userId,
      target: { type: 'block', label: 'persona' },
      patch: { content: '中文回答，简短，少用形容词。' },
      actor: 'human',
    });
    // 四类块均可由调用方写入；persona/rules 默认走人工审核
    const pendingRules = await correct(ctx, {
      userId,
      target: { type: 'block', label: 'rules' },
      patch: { content: '模型提议：回答前先给结论，并标注不确定性。' },
      actor: 'agent',
    });
    check(
      'agent 写 rules 进入人工审核队列',
      pendingRules.pending_approval === true && typeof pendingRules.candidate_id === 'number',
      `candidate=${pendingRules.candidate_id}`,
    );

    const rulesUnchanged = await sql<Array<{ content: string }>>`
      SELECT content FROM mem_block
      WHERE user_id = ${userId} AND label = 'rules' AND slot = 'default' AND deleted_at IS NULL`;
    check(
      '待审期间 rules 内容未生效',
      rulesUnchanged[0]?.content === '回答前先给结论；不确定时明说不确定。',
      rulesUnchanged[0]?.content,
    );

    const pendingPersona = await correct(ctx, {
      userId,
      target: { type: 'block', label: 'persona' },
      patch: { content: '中文回答，先结论后细节，避免形容词堆砌。' },
      actor: 'agent',
    });
    check('agent 写 persona 默认也进审核', pendingPersona.pending_approval === true);

    const blockCandidates = (await listCandidates(ctx, userId, 'pending')).filter((c) => c.kind === 'block');
    check('待审队列可见块变更候选', blockCandidates.length >= 1, `count=${blockCandidates.length}`);

    const rulesCandidate = blockCandidates.find(
      (c) => (c.payload as { label?: string }).label === 'rules',
    );
    if (rulesCandidate) {
      const approvedBlock = await approveCandidate(ctx, userId, rulesCandidate.id, 'human');
      check('人工批准后写入 rules', Boolean(approvedBlock.block_id));
      const applied = await sql<Array<{ content: string; source: string }>>`
        SELECT content, source FROM mem_block WHERE id = ${approvedBlock.block_id ?? 0}`;
      check(
        '批准内容生效且来源标记为 agent',
        applied[0]?.content === '模型提议：回答前先给结论，并标注不确定性。' && applied[0]?.source === 'agent',
        `source=${applied[0]?.source}`,
      );
    } else {
      check('人工批准后写入 rules', false, '未找到 rules 候选');
    }
    await expectError(
      '块超限返回 E_BLOCK_LIMIT（FR-01）',
      () =>
        correct(ctx, {
          userId,
          target: { type: 'block', label: 'persona' },
          // persona 上限 2200（与 SurfCore 对齐），超 800 字足以触发
        patch: { content: 'x'.repeat(3001) },
          actor: 'human',
        }),
      'E_BLOCK_LIMIT',
    );

    const w1 = await write(ctx, { messages: STOCK_MESSAGES(1), close: false, scope: 'demo' });
    check('未达阈值时卡待浓缩（FR-09）', w1.card_pending === true && w1.raw_ids.length === 2, `turns=${w1.turns}`);

    const w2 = await write(ctx, { messages: STOCK_MESSAGES(2), event_id: w1.event_id, close: true });
    check('显式关闭后生成 L2 卡', w2.card_id !== null && w2.card_pending === false, `card=${w2.card_id}`);

    const zero = await recall(ctx, { query: '完全无关的天气问题' });
    check('无命中时预算仍受控（FR-07）', zero.blocks.length === 0 && zero.budget_used <= 1200);
    check(
      '空召回给出提示与最近记录兜底',
      typeof zero.note === 'string' && zero.note.includes('实词') && zero.hints.length >= 1,
      `note=${zero.note?.slice(0, 20)} hints=${zero.hints.length}`,
    );
    check('默认不返回调试明细', (zero as { trace?: unknown }).trace === undefined && zero.dropped.length === 0);

    const started = await callTool(ctx, 'memory.start', {}) as {
      recall_id?: number;
      blocks: Array<{ label: string; text: string }>;
      hook_check: { settings_path: string; skill_block_id: number };
    };
    check(
      'memory.start 注入 persona/rules 并返回 hook 自检',
      (started.blocks ?? []).some((b) => b.label === 'persona') &&
        (started.blocks ?? []).some((b) => b.label === 'rules') &&
        typeof started.recall_id === 'number' &&
        started.hook_check?.skill_block_id === 123,
      `blocks=${started.blocks?.length} recall_id=${started.recall_id}`,
    );

    const r1 = await recall(ctx, { query: '股票行情怎么样，新能源和算力选哪个好？', debug: true });
    check('召回不超预算上限（FR-07）', r1.budget_used <= r1.budget_limit && r1.budget_limit === 1200, `${r1.budget_used}/${r1.budget_limit}`);
    check('recall 不再重复注入 L1 常驻块', r1.blocks.length === 0, `blocks=${r1.blocks.length}`);
    check('命中事件卡或提示行（S2）', r1.cards.length + r1.hints.length >= 1, `cards=${r1.cards.length} hints=${r1.hints.length}`);
    check('L1.5 只含 event_id 与关键词（FR-02）', r1.recent_index.every((x) => Array.isArray(x.keywords) && x.keywords.length <= 3));
    check('trace 记录种子词', Array.isArray(r1.trace?.seeds));
    check(
      'cards 与 hints 互斥',
      r1.cards.every((card) => !r1.hints.some((hint) => hint.card_id === card.id)),
      `cards=${r1.cards.length} hints=${r1.hints.length}`,
    );
    check(
      '所有摘要不超过 200 字',
      r1.cards.every((card) => [...card.summary].length <= 200),
      `max=${Math.max(0, ...r1.cards.map((c) => [...c.summary].length))}`,
    );
    check(
      '召回卡回传 source 以辨识外部内容',
      r1.cards.length > 0 && r1.cards.every((card) => typeof card.source === 'string' && card.source.length > 0),
      r1.cards.map((card) => card.source).join(',') || '(无卡)',
    );

    const ex = await expand(ctx, { cardId: w2.card_id as number });
    check('下钻返回 L3 原文引用（FR-08）', ex.raw_refs.length >= 1, `raw=${ex.raw_refs.length}`);
    check('下钻返回可继续的 ID', ex.next.term_ids.length >= 1);
    const exTerm = await expand(ctx, { term: ex.card?.terms?.[0]?.name ?? '股票' });
    check('按 term 展开一跳', exTerm.term !== null && exTerm.cards.length >= 1, `cards=${exTerm.cards.length}`);

    // ---------------------------------------------------------- A2. 重复性判定（同会话追加）
    const appendScope = 'append-test';
    const seedCard = await write(ctx, {
      messages: [
        { role: 'user', content: '部署流程改成 Canary：先 10% 流量，异常自动回滚。' },
        { role: 'assistant', content: '可以，Canary 阶段盯错误率和 P95 延迟，超阈自动回滚上一版本。' },
      ],
      close: true,
      scope: appendScope,
      card: {
        summary: '部署流程改为 Canary 发布：先放 10% 流量，监控错误率与 P95 延迟，异常时自动回滚到上一版本。',
        keywords: ['部署', 'Kubernetes', '回滚'],
        intent: '决策',
      },
    });
    check(
      '首次事件新建卡',
      typeof seedCard.card_id === 'number' && seedCard.appended !== true,
      `card=${seedCard.card_id}`,
    );

    const appendedCard = await write(ctx, {
      messages: [
        { role: 'user', content: '继续：Canary 扩到 30%，加灰度白名单，回滚策略不变。' },
        { role: 'assistant', content: '好，30% 阶段加白名单并保持同样的自动回滚阈值。' },
      ],
      scope: appendScope,
      append_to: seedCard.card_id as number,
      card: {
        summary: '继续完善部署：Canary 扩到 30% 并加入灰度白名单，自动回滚阈值与上一阶段保持一致。',
        keywords: ['部署', 'Kubernetes', '灰度'],
        intent: '决策',
      },
    });
    check(
      'append_to 未 close 也立即成卡并返回目标卡 id',
      appendedCard.appended === true &&
        appendedCard.card_id === seedCard.card_id &&
        appendedCard.target_card_id === seedCard.card_id &&
        appendedCard.card_pending === false,
      `card=${appendedCard.card_id} target=${appendedCard.target_card_id}`,
    );

    const pendingWrite = await write(ctx, {
      messages: [
        { role: 'user', content: '先记一半：还有一套回滚演练方案待确认。' },
        { role: 'assistant', content: '好，先放着，等确认后再成卡。' },
      ],
      scope: 'pending-test',
    });
    check(
      '未成卡时返回 pending_ref 供续写',
      pendingWrite.card_pending === true &&
        pendingWrite.card_id === null &&
        pendingWrite.pending_ref?.event_id === pendingWrite.event_id,
      `event=${pendingWrite.pending_ref?.event_id}`,
    );

    try {
      await write(ctx, {
        messages: [
          { role: 'user', content: '目标卡不存在时应该报错。' },
          { role: 'assistant', content: '收到。' },
        ],
        append_to: 999_999,
      });
      check('append_to 目标不存在时报错并带字段', false, '未抛错');
    } catch (err) {
      const details = (err as { details?: { field?: string } }).details;
      check(
        'append_to 目标不存在时报错并带字段',
        isAppError(err) && err.code === 'E_TARGET_NOT_FOUND' && details?.field === 'append_to',
        details?.field,
      );
    }

    const skillTermId = Number(ex.card?.terms?.[0]?.id);
    let skillBlockId = 0;
    if (Number.isFinite(skillTermId) && skillTermId > 0) {
      const skillWrite = await correct(ctx, {
        userId,
        target: { type: 'block', label: 'skills', slot: `skill:${skillTermId}` },
        patch: {
          summary: '提到股票时先给结论，再补一条可执行建议',
          content:
            '条件：用户提到股票或仓位。做法：先给当前结论，再给一条可执行建议，最后补一句风险提示。',
        },
        actor: 'agent',
      });
      skillBlockId = skillWrite.object_id;
      check('skills 支持 term 级槽位写入', skillWrite.pending_approval !== true && skillWrite.object_id > 0);
      const skillRow = await sql<
        Array<{ slot: string; char_limit: number; source: string; summary: string | null; content: string }>
      >`
        SELECT slot, char_limit, source, summary, content FROM mem_block WHERE id = ${skillWrite.object_id}`;
      check(
        'skills 条目：槽位/来源/详细描述上限正确',
        skillRow[0]?.slot === `skill:${skillTermId}` &&
          Number(skillRow[0]?.char_limit) === ctx.cfg.life.skillDetailMaxChars &&
          skillRow[0]?.source === 'agent',
        `slot=${skillRow[0]?.slot} limit=${skillRow[0]?.char_limit}`,
      );
      check(
        'skills 条目：一句话描述与详细描述分开存',
        skillRow[0]?.summary === '提到股票时先给结论，再补一条可执行建议' &&
          (skillRow[0]?.content ?? '').includes('做法'),
        `summary=${skillRow[0]?.summary?.slice(0, 12)}`,
      );
    }

    if (skillBlockId > 0) {
      // 走 MCP 层调用，确保 block_id 参数真的被映射到 service（曾漏过）
      const firstUse = (await callTool(ctx, 'memory.expand', { block_id: skillBlockId })) as {
        block?: { summary: string | null; content: string; use_count: number };
      };
      check(
        'MCP expand 按 block_id 取回：一句话描述 + 详细描述都在',
        firstUse.block?.summary === '提到股票时先给结论，再补一条可执行建议' &&
          (firstUse.block?.content ?? '').includes('做法'),
        `summary=${firstUse.block?.summary?.slice(0, 12)}`,
      );
      check('取用一次后调用次数为 1', firstUse.block?.use_count === 1, String(firstUse.block?.use_count));
      const secondUse = await expand(ctx, { blockId: skillBlockId });
      check('再次取用累计到 2', secondUse.block?.use_count === 2, String(secondUse.block?.use_count));
    }

    try {
      await correct(ctx, {
        userId,
        target: { type: 'block', label: 'skills' },
        patch: { text: '用错字段名' },
        actor: 'agent',
      });
      check('块 patch 用错字段时回传 field', false, '未抛错');
    } catch (err) {
      const details = (err as { details?: { field?: string; accepted_keys?: string[] } }).details;
      check(
        '块 patch 用错字段时回传 field 与 accepted_keys',
        isAppError(err) && err.code === 'E_INVALID' && details?.field === 'patch.content' && Array.isArray(details?.accepted_keys),
        details?.field,
      );
    }

    const mergedRows = await sql<Array<{ version: number; keywords: string[]; summary: string }>>`
      SELECT version, keywords, summary FROM mem_card WHERE id = ${seedCard.card_id as number}`;
    check(
      '追加后版本递增、关键词取并集、摘要带滚动追加段',
      Number(mergedRows[0]?.version) >= 2 &&
        (mergedRows[0]?.keywords ?? []).includes('灰度') &&
        (mergedRows[0]?.summary ?? '').includes('追加'),
      `v=${mergedRows[0]?.version} kw=${(mergedRows[0]?.keywords ?? []).join(',')}`,
    );

    const replaced = await write(ctx, {
      messages: [
        { role: 'user', content: '部署结论更新：改为蓝绿发布，Canary 只留作回滚手段。' },
        { role: 'assistant', content: '收到，蓝绿为主，Canary 仅用于回滚验证。' },
      ],
      scope: appendScope,
      append_to: seedCard.card_id as number,
      summary_mode: 'replace',
      card: {
        summary: '部署方案改为蓝绿发布：两套环境切换，Canary 仅保留用于回滚验证，回滚阈值不变。',
        keywords: ['部署', '蓝绿', '回滚'],
        intent: '决策',
      },
    });
    const replacedRows = await sql<Array<{ summary: string; keywords: string[] }>>`
      SELECT summary, keywords FROM mem_card WHERE id = ${seedCard.card_id as number}`;
    check(
      'summary_mode=replace 覆盖原摘要并保留关键词并集',
      replaced.appended === true &&
        replacedRows[0]?.summary === '部署方案改为蓝绿发布：两套环境切换，Canary 仅保留用于回滚验证，回滚阈值不变。' &&
        (replacedRows[0]?.keywords ?? []).includes('蓝绿'),
      `len=${[...(replacedRows[0]?.summary ?? '')].length}`,
    );

    const cardSearch = (await callTool(ctx, 'memory.cards', {
      q: '部署',
      page: 1,
      page_size: 5,
    })) as { items: Array<{ card_id: number; summary: string }>; total: number };
    check(
      'memory.cards 可按关键词搜卡并返回 id',
      cardSearch.total >= 1 && cardSearch.items.every((item) => item.card_id > 0),
      `total=${cardSearch.total}`,
    );

    const notMerged = await write(ctx, {
      messages: [
        { role: 'user', content: '同一件事再补一条：明天把 Canary 提到 50%。' },
        { role: 'assistant', content: '收到，明天 50%，回滚阈值不变。' },
      ],
      close: true,
      scope: appendScope,
      card: {
        summary: '部署计划更新：明天把 Canary 流量提到 50%，自动回滚阈值保持不变，白名单继续生效。',
        keywords: ['部署', 'Kubernetes', '预案'],
        intent: '决策',
      },
    });
    check(
      '未传 append_to 时服务端不擅自合并',
      notMerged.appended !== true && notMerged.card_id !== seedCard.card_id,
      `card=${notMerged.card_id}`,
    );

    const autoMerged = await write(ctx, {
      messages: [
        { role: 'user', content: '部署观察项：Canary 期间盯 P99 和 5xx。' },
        { role: 'assistant', content: '记录：P99 和 5xx 超阈立即回滚。' },
      ],
      close: true,
      scope: appendScope,
      dedupe: true,
      card: {
        summary: '部署观察项补充：Canary 期间重点盯 P99 与 5xx 比例，超阈立即触发回滚，阈值沿用上一阶段。',
        keywords: ['部署', 'Kubernetes', '观察'],
        intent: '决策',
      },
    });
    check(
      'dedupe=true 时启用服务端兜底合并',
      autoMerged.appended === true,
      `card=${autoMerged.card_id} reason=${autoMerged.append_reason}`,
    );

    const otherTopic = await write(ctx, {
      messages: [
        { role: 'user', content: '周末去露营，装备要带什么？' },
        { role: 'assistant', content: '帐篷、睡袋、炉具、照明，按两天一夜轻量化配置。' },
      ],
      close: true,
      scope: appendScope,
      card: {
        summary: '周末露营装备清单：帐篷、睡袋、炉具与照明，按两天一夜的轻量化方案准备，兼顾保暖与负重。',
        keywords: ['露营', '装备', '帐篷'],
        intent: '求推荐',
      },
    });
    check(
      '同一会话换主题新建卡',
      otherTopic.appended !== true && otherTopic.card_id !== seedCard.card_id,
      `card=${otherTopic.card_id}`,
    );

    // ---------------------------------------------------------- B. 更正与审计
    const patched = await correct(ctx, {
      userId,
      target: { type: 'card', id: w2.card_id as number },
      patch: { summary: '股票行情讨论：新能源资金流出、算力更强。结论是减新能源到三成、保留底仓、优先算力方向。' },
      reason: '人工纠错',
      actor: 'human',
    });
    check('更正后版本递增（FR-13）', patched.version >= 2, `version=${patched.version}`);
    const audits = await listAudit(ctx, userId, { objectType: 'card', objectId: w2.card_id as number });
    check('审计含 before/after（G4）', audits.some((a) => a.before !== null && a.after !== null));
    await expectError(
      'L3 明细不可修改（FR-04）',
      () => correct(ctx, { userId, target: { type: 'raw', id: w1.raw_ids[0] as number }, patch: { content: 'x' }, actor: 'human' }),
      'E_IMMUTABLE_RAW',
    );

    // ---------------------------------------------------------- C. 批量写入 + 预算 + 热度固化
    for (let i = 3; i <= 14; i++) {
      await write(ctx, { messages: STOCK_MESSAGES(i), close: true, scope: 'demo' });
    }
    const r2 = await recall(ctx, { query: '股票行情新能源算力板块仓位推荐', debug: true });
    check('50+ 候选场景仍不超 1200（G1）', r2.budget_used <= 1200, `${r2.budget_used}`);
    check('弱关联不占预算且仅提示（FR-07）', r2.hints.every((h) => h.text.startsWith('提示')) && r2.budget_used <= 1200);
    check(
      '丢弃明细与计数一致（NFR-07）',
      r2.dropped_count === r2.dropped.length && r2.truncated === r2.dropped.some((d) => d.reason === 'budget'),
      `dropped=${r2.dropped_count} truncated=${r2.truncated}`,
    );

    const skillsBeforeRows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mem_block
      WHERE user_id = ${userId} AND label = 'skills' AND slot LIKE 'skill:%' AND deleted_at IS NULL`;
    const skillsBefore = Number(skillsBeforeRows[0]?.n ?? 0);

    const patrol1 = await runPatrol(ctx, userId);
    const skills = await sql<Array<{ id: number; slot: string; summary: string | null; content: string; source: string; ref_cards: number[]; ref_terms: number[] }>>`
      SELECT id, slot, summary, content, source, ref_cards, ref_terms FROM mem_block
      WHERE user_id = ${userId} AND label = 'skills' AND slot LIKE 'skill:%' AND deleted_at IS NULL`;
    check(
      '巡检不再自动固化技能（只由调用方写入）',
      skills.length === skillsBefore && skills.every((s) => s.source === 'agent'),
      `before=${skillsBefore} after=${skills.length}`,
    );
    check(
      '经验条带来源指针，一句话描述 ≤60 字、详细描述 ≤400 字',
      skills.length >= 1 &&
        skills.every(
          (s) =>
            (s.ref_cards ?? []).length >= 1 &&
            (s.ref_terms ?? []).length >= 1 &&
            (s.summary ?? '').length > 0 &&
            [...(s.summary ?? '')].length <= 60 &&
            [...s.content].length <= 400,
        ),
      `summary=${skills[0]?.summary?.slice(0, 12)}`,
    );
    check(
      '巡检产出报告（NFR-08）',
      patrol1.duration_ms >= 0 && patrol1.finished_at !== '' && typeof patrol1.evicted === 'number',
      `evicted=${patrol1.evicted} demoted=${patrol1.demotion}`,
    );

    const started3 = await callTool(ctx, 'memory.start', {}) as {
      blocks: Array<{ label: string; text: string }>;
    };
    const indexBlock = (started3.blocks ?? []).find((b) => b.label === 'skills');
    check(
      'start 注入经验索引（id + 一句话描述）',
      indexBlock !== undefined &&
        indexBlock.text.includes('经验索引') &&
        indexBlock.text.includes(`#${skillBlockId}`) &&
        indexBlock.text.includes('提到股票时先给结论'),
      indexBlock?.text.slice(0, 80),
    );
    check('经验索引不含详细描述正文', indexBlock !== undefined && !indexBlock.text.includes('做法'));
    check(
      '经验索引展示调用次数',
      indexBlock !== undefined && indexBlock.text.includes('（2 次）'),
      indexBlock?.text.match(/（\d+ 次）/)?.[0],
    );

    const candidates = await listCandidates(ctx, userId, 'pending');
    if (candidates.length > 0) {
      const approved = await approveCandidate(ctx, userId, candidates[0]?.id as number, 'human');
      check('人工候选可批准（FR-09）', approved !== null);
    } else {
      check('人工候选队列可用（空队列跳过）', true);
    }

    // ---------------------------------------------------------- D. 遗忘与回收站
    const listBefore = await listCards(ctx, userId, { pageSize: 100 });
    const targetCard = listBefore.items[0];
    if (targetCard) {
      await forget(ctx, { userId, target: { type: 'card', id: targetCard.id }, mode: 'soft', actor: 'human' });
      const listAfter = await listCards(ctx, userId, { pageSize: 100 });
      check('软删后不再出现在列表（S4）', !listAfter.items.some((c) => c.id === targetCard.id));
      await restoreSoft(ctx, userId, 'card', targetCard.id, 'human');
      const listRestored = await listCards(ctx, userId, { pageSize: 100 });
      check('软删可恢复', listRestored.items.some((c) => c.id === targetCard.id));

      await expectError(
        '物理清除需二次确认',
        () => forget(ctx, { userId, target: { type: 'card', id: targetCard.id }, mode: 'purge', confirm: false, actor: 'human' }),
        'E_NOT_APPROVED',
      );
      const purged = await forget(ctx, {
        userId,
        target: { type: 'card', id: targetCard.id },
        mode: 'purge',
        confirm: true,
        actor: 'human',
      });
      check('物理清除先进回收站（FR-16）', typeof purged.trash_id === 'number');
      const trash = await listTrash(ctx, userId);
      check('回收站可见', trash.some((t) => t.kind === 'snapshot' && t.id === purged.trash_id));
      await restoreSnapshot(ctx, userId, purged.trash_id as number, 'human');
      const listRestored2 = await listCards(ctx, userId, { pageSize: 100 });
      check('清除后 7 天内可恢复（FR-16）', listRestored2.items.some((c) => c.id === targetCard.id));
    }

    // ---------------------------------------------------------- E. 图谱与 MCP
    const graph = await graphData(ctx, userId, { limit: 200 });
    check('图谱返回节点与簇（FR-12）', graph.nodes.length >= 1 && graph.clusters.length >= 1, `nodes=${graph.nodes.length} clusters=${graph.clusters.length}`);
    check('簇与节点关联一致', graph.nodes.every((n) => graph.clusters.some((c) => c.id === n.cluster)));
    const focused = await graphData(ctx, userId, { focus: '股票', limit: 50 });
    check('聚焦查询命中节点', focused.focus !== null && focused.nodes.length >= 1);
    const radial = await graphRadial(ctx, userId, { minCards: 1 });
    check(
      '径向图谱返回根+全部卡+全部词',
      radial.nodes.some((n) => n.id === 'l1:root') &&
        radial.nodes.some((n) => n.type === 'card') &&
        radial.nodes.some((n) => n.type === 'term') &&
        radial.edges.some((e) => e.type === 'holds' && e.target.startsWith('term:')) &&
        radial.edges.some((e) => e.type === 'mentions' && e.source.startsWith('term:')),
      `nodes=${radial.nodes.length} edges=${radial.edges.length}`,
    );

    const mcpRecall = (await callTool(ctx, 'memory.recall', { query: '股票行情', budget_tokens: 600 })) as {
      budget_used: number;
      budget_limit: number;
    };
    check('MCP recall 可用且尊重预算（G5）', mcpRecall.budget_used <= mcpRecall.budget_limit && mcpRecall.budget_limit === 600);
    const mcpTools = MCP_TOOLS.map((tool) => tool.name);
    check(
      '10 个工具均已注册',
      [
        'memory.start',
        'memory.recall',
        'memory.inspect',
        'memory.expand',
        'memory.write',
        'memory.write.batch',
        'memory.cards',
        'memory.correct',
        'memory.forget',
        'memory.pending',
      ].every((name) => mcpTools.includes(name)),
      mcpTools.join(','),
    );

    // ---------------------------------------------------------- F. 淡忘（模拟 120 天未命中）
    const coldCandidate = (await listCards(ctx, userId, { pageSize: 100 })).items.find((c) => !c.is_skeleton);
    if (coldCandidate) {
      await sql`
        UPDATE mem_card SET heat = 0.1, heat_at = now(), last_hit_at = now() - interval '120 days',
          hit_count = 0, importance = 0.5, pinned = false, category = 'general'
        WHERE id = ${coldCandidate.id}`;
      const coldRecall = await recall(ctx, { query: '股票行情新能源算力' });
      check(
        '冷记忆不进默认召回（FR-14）',
        !coldRecall.cards.some((c) => c.id === coldCandidate.id),
        `card=${coldCandidate.id}`,
      );
      const patrol2 = await runPatrol(ctx, userId);
      check(
        '巡检只报待淡忘候选，不再自动压骨架',
        patrol2.decay_candidates >= 1,
        `candidates=${patrol2.decay_candidates}`,
      );

      // 淡忘改由调用方决定：这里显式执行一次，验证动作本身
      const skeletonRes = await forget(ctx, {
        userId,
        target: { type: 'card', id: coldCandidate.id },
        mode: 'skeleton',
        reason: '冒烟：验证睡觉时的淡忘动作',
      });
      check(
        'forget(mode=skeleton) 压成骨架',
        skeletonRes.mode === 'skeleton',
        `card=${coldCandidate.id}`,
      );

      const skeletonRows = await sql<Array<{ summary: string; is_skeleton: boolean }>>`
        SELECT summary, is_skeleton FROM mem_card WHERE id = ${coldCandidate.id}`;
      const row = skeletonRows[0];
      check(
        '骨架卡 ≤80 字且不再持有原文',
        row?.is_skeleton === true && [...(row?.summary ?? '')].length <= 80,
        `len=${[...(row?.summary ?? '')].length}`,
      );
      const rawLinks = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM card_raw WHERE card_id = ${coldCandidate.id}`;
      check('骨架卡断开 L3 引用', Number(rawLinks[0]?.n ?? 0) === 0);
    }

    // 技能详细描述上限扩展后可写入超过 400 字的正文
    if (Number.isFinite(skillTermId) && skillTermId > 0) {
      const longSkill = await correct(ctx, {
        userId,
        target: { type: 'block', label: 'skills', slot: `skill:${skillTermId}` },
        patch: {
          summary: '提到股票时先给结论，再补一条可执行建议',
          content: '条件：用户提到股票或仓位。做法：先给当前结论，再给一条可执行建议，最后补一句风险提示。'.repeat(30),
        },
        actor: 'agent',
      });
      check(
        '技能详细描述可超过 400 字',
        longSkill.pending_approval !== true && longSkill.version >= 2,
        `v=${longSkill.version}`,
      );
    }

    // ---------------------------------------------------------- 汇总
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n共 ${checks.length} 项检查，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    }
    return failed.length > 0 ? 1 : 0;
  } finally {
    // 清理必须有上限：连接或集群停不下来时也要保证脚本退出
    await bounded('关闭连接池', sql ? closeSql(sql) : null, 5000);
    await bounded('停止嵌入式 PostgreSQL', pg.stop(), 20_000);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function bounded(label: string, task: Promise<unknown> | null, ms: number): Promise<void> {
  if (!task) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[cleanup] ${label} 超时（${ms}ms），继续退出`);
      resolve();
    }, ms);
  });
  try {
    await Promise.race([task.catch(() => {}), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('冒烟失败：', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
