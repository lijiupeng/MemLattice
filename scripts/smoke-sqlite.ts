/* eslint-disable no-console */
/**
 * SQLite 冒烟：在临时目录建库 → 跑全量建表 → bootstrap → 校验默认数据与关键语法。
 * 不依赖 Docker 或外部数据库，可进 CI。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createTokenizer } from '../src/core/tokenizer.js';
import { bootstrap } from '../src/db/bootstrap.js';
import { closeSql, createSql } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrate.js';
import type { Ctx } from '../src/services/context.js';
import {
  graphData,
  listAudit,
  listBlockDetails,
  listCandidates,
  listCards,
  listTerms,
} from '../src/services/governance.service.js';
import { graphRadial } from '../src/services/graph.service.js';
import { runPatrol } from '../src/services/lifecycle.service.js';
import { runPatrolIfStale } from '../src/scheduler.js';
import { sleepReport, triageItems } from '../src/services/maintenance.service.js';
import {
  correct,
  feedback,
  forget,
  listTrash,
  recall,
  restoreSnapshot,
  startPreview,
  startSession,
  write,
} from '../src/services/memory.service.js';

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'memlattice-sqlite-'));
  process.env.DB_DIALECT = 'sqlite';
  process.env.SQLITE_PATH = join(dir, 'memlattice.db');

  const cfg = loadConfig();
  check('默认识别为 sqlite 引擎', cfg.dbDialect === 'sqlite', `dir=${cfg.migrationsDir}`);

  const sql = createSql(cfg);
  check('驱动为 sqlite', sql.dialect === 'sqlite');

  try {
    const applied = await migrateUp(sql, cfg.migrationsDir, (msg) => console.log(`        ${msg}`));
    check('全量建表脚本可执行', applied.includes('001_init.sql'), applied.join(','));

    const tables = await sql<Array<{ name: string }>>`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    const names = tables.map((row) => row.name);
    const expected = [
      'app_setting',
      'app_user',
      'card_raw',
      'card_term',
      'condense_job',
      'mem_audit',
      'mem_block',
      'mem_card',
      'mem_event',
      'mem_injection',
      'mem_raw',
      'mem_trash',
      'mem_triage',
      'mem_version',
      'promotion_candidate',
      'schema_migration',
      'term',
      'term_edge',
    ];
    const missing = expected.filter((name) => !names.includes(name));
    check('全部表已建立', missing.length === 0, missing.length ? `missing=${missing.join(',')}` : `tables=${names.length}`);

    const userId = await bootstrap(sql, cfg);
    const blocks = await sql<Array<{ label: string; char_limit: number }>>`
      SELECT label, char_limit FROM mem_block WHERE user_id = ${userId} ORDER BY id`;
    check('bootstrap 建出三类常驻块', blocks.length === 3, blocks.map((b) => b.label).join(','));

    // 运维技能改成包内文档（dsh/memlattice/SURFCORE.md），初始化不再往 skills 里塞内容
    const skillsSeed = await sql<Array<{ content: string }>>`
      SELECT content FROM mem_block
      WHERE user_id = ${userId} AND label = 'skills' AND slot = 'default'`;
    check(
      '初始化不往 skills 塞工具说明',
      String(skillsSeed[0]?.content ?? '') === '',
      `len=${[...String(skillsSeed[0]?.content ?? '')].length}`,
    );
    check('skills 槽位上限抬到 4000', blocks.find((b) => b.label === 'skills')?.char_limit === 4000);

    const repeated = await bootstrap(sql, cfg);
    check('重复 bootstrap 幂等', repeated === userId, `user=${userId}`);

    // 数组列按 JSON 文本存，读回来必须已经是数组
    await sql`
      UPDATE mem_block SET ref_cards = ${sql.array([1, 2, 3])}
      WHERE user_id = ${userId} AND label = 'persona'`;
    const refs = await sql<Array<{ ref_cards: number[] }>>`
      SELECT ref_cards FROM mem_block WHERE user_id = ${userId} AND label = 'persona'`;
    check('数组列写入后读回为数组', Array.isArray(refs[0]?.ref_cards) && refs[0]?.ref_cards.length === 3);

    // IN 列表展开
    const picked = await sql<Array<{ label: string }>>`
      SELECT label FROM mem_block WHERE user_id = ${userId} AND label IN (${['persona', 'rules']}) ORDER BY label`;
    check('IN 列表按参数展开', picked.length === 2, picked.map((p) => p.label).join(','));

    // 日期与布尔：驱动层要落成 SQLite 可绑定类型
    const now = new Date('2026-01-02T03:04:05.000Z');
    await sql`
      INSERT INTO mem_event (user_id, status, started_at)
      VALUES (${userId}, 'open', ${now})`;
    const event = await sql<Array<{ started_at: string }>>`
      SELECT started_at FROM mem_event WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1`;
    check('Date 参数落为 ISO 文本', event[0]?.started_at === now.toISOString(), event[0]?.started_at);

    const inserted = await sql<Array<{ id: number; summary: string }>>`
      INSERT INTO mem_card (event_id, user_id, summary, keywords, is_skeleton)
      VALUES (
        (SELECT id FROM mem_event WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1),
        ${userId},
        ${'这是一条用于验证 SQLite 链路的摘要，长度需要超过四十个字符才能通过约束检查，因此这里写得长一点。'},
        ${sql.array(['sqlite', '双后端'])},
        false
      )
      RETURNING id, summary`;
    check('INSERT ... RETURNING 可用', typeof inserted[0]?.id === 'number', `id=${inserted[0]?.id}`);

    const card = await sql<Array<{ keywords: string[]; is_skeleton: number }>>`
      SELECT keywords, is_skeleton FROM mem_card WHERE id = ${inserted[0]?.id}`;
    check('布尔写入后读回为 0', card[0]?.is_skeleton === 0, String(card[0]?.is_skeleton));
    check('卡片关键词读回为数组', Array.isArray(card[0]?.keywords) && card[0]?.keywords[0] === 'sqlite');

    const count = await sql<Array<{ n: number }>>`
      SELECT CAST(count(*) AS INTEGER) AS n FROM mem_card`;
    check('CAST 计数可用', Number(count[0]?.n) === 1, `n=${count[0]?.n}`);

    /* -------------------------------------------------------- 业务链路 */

    const tokenizer = await createTokenizer();
    const ctx: Ctx = { sql, cfg, tokenizer, now: () => new Date(), cachedUserId: userId };

    const w1 = await write(ctx, {
      messages: [
        { role: 'user', content: 'SQLite 这条链路要能写卡：先把这句话记住。' },
        { role: 'assistant', content: '已记录，稍后用召回验证。' },
      ],
      close: true,
      scope: 'sqlite-smoke',
      card: {
        summary:
          'SQLite 双后端验证：写入链路需要能生成事件卡，召回时按预算取回，关键词与实体以 JSON 文本落库。',
        keywords: ['SQLite', '双后端', '召回'],
        intent: '信息同步',
      },
    });
    const jobs = await sql<Array<{ last_error: string | null }>>`
      SELECT last_error FROM condense_job ORDER BY id DESC LIMIT 1`;
    check(
      'write 在 SQLite 下成卡',
      typeof w1.card_id === 'number',
      `card=${w1.card_id} pending=${w1.card_pending} raw=${w1.raw_ids.length} err=${jobs[0]?.last_error ?? '-'}`,
    );

    const r1 = await recall(ctx, { query: 'SQLite 双后端 召回' });
    check(
      'recall 在 SQLite 下命中并受预算约束',
      (r1.cards.length > 0 || r1.hints.length > 0) && r1.budget_used <= cfg.budget.defaultTokens,
      `cards=${r1.cards.length} hints=${r1.hints.length} used=${r1.budget_used}`,
    );

    // 曝光与采用分离：再召回一次同一张卡，只应涨 hit_count
    const hitTarget = r1.cards[0];
    const beforeHit = hitTarget
      ? (
          await sql<Array<{ heat: number; hit_count: number; use_count: number }>>`
            SELECT heat, hit_count, use_count FROM mem_card WHERE id = ${hitTarget.id}`
        )[0]
      : undefined;
    const r2 = await recall(ctx, { query: 'SQLite 双后端 召回' });
    const hitAgain = hitTarget ? r2.cards.some((item) => item.id === hitTarget.id) : false;
    const afterHit = hitTarget
      ? (
          await sql<Array<{ heat: number; hit_count: number; use_count: number }>>`
            SELECT heat, hit_count, use_count FROM mem_card WHERE id = ${hitTarget.id}`
        )[0]
      : undefined;
    check(
      'recall 只记曝光，不加热度也不计采用',
      hitAgain &&
        Number(afterHit?.hit_count) === Number(beforeHit?.hit_count) + 1 &&
        Number(afterHit?.heat) === Number(beforeHit?.heat) &&
        Number(afterHit?.use_count) === Number(beforeHit?.use_count),
      `hit ${beforeHit?.hit_count}→${afterHit?.hit_count} heat ${beforeHit?.heat}→${afterHit?.heat} use ${beforeHit?.use_count}→${afterHit?.use_count}`,
    );

    const fb = await feedback(ctx, {
      userId,
      cardId: Number(w1.card_id),
      verdict: 'wrong',
      note: 'SQLite 冒烟：验证判错降置信',
    });
    check('feedback=wrong 下调置信度', Math.abs(fb.confidence - 0.6) < 1e-9, `confidence=${fb.confidence}`);

    // 空块不参与注入，先写入内容再验证 L1 装配
    await sql`
      UPDATE mem_block SET content = 'SQLite 验证用 persona：先给结论，再补要点。'
      WHERE user_id = ${userId} AND label = 'persona'`;
    const started = await startSession(ctx, userId);
    check('memory.start 在 SQLite 下注入常驻块', started.blocks.length >= 1, `blocks=${started.blocks.length}`);

    const listed = await listCards(ctx, userId, { pageSize: 10 });
    check(
      'listCards 在 SQLite 下可用且关键词为数组',
      listed.total >= 1 && Array.isArray(listed.items[0]?.keywords),
      `total=${listed.total}`,
    );

    const appended = await write(ctx, {
      messages: [
        { role: 'user', content: '再补一条：追加到同一张卡上。' },
        { role: 'assistant', content: '已追加，版本会递增。' },
      ],
      scope: 'sqlite-smoke',
      append_to: w1.card_id as number,
      card: {
        summary:
          'SQLite 追加验证：在已有卡片上追加一轮内容，版本递增、关键词取并集，摘要滚动合并后仍不超过长度上限。',
        keywords: ['SQLite', '追加'],
        intent: '信息同步',
      },
    });
    check(
      'append_to 在 SQLite 下并入原卡',
      appended.appended === true && appended.card_id === w1.card_id,
      `card=${appended.card_id}`,
    );

    // 30 天墙：创建于 90 天前、但昨天刚被命中的卡，仍应进强关联而不是掉进提示行
    const dayMs = 86_400_000;
    await sql`
      UPDATE mem_card
      SET created_at = ${new Date(Date.now() - 90 * dayMs)},
          last_hit_at = ${new Date(Date.now() - dayMs)}
      WHERE id = ${w1.card_id}`;
    const r3 = await recall(ctx, { query: 'SQLite 双后端 召回' });
    check(
      '久置但近期命中的卡仍进强关联',
      r3.cards.some((item) => item.id === w1.card_id),
      `cards=${r3.cards.map((item) => item.id).join(',')}`,
    );

    /* ---------------------------------------------------- 管理端接口 */

    const blocksDetail = await listBlockDetails(ctx, userId);
    check(
      '常驻层详情按 persona→rules→skills 排序',
      blocksDetail.length >= 3 && blocksDetail[0]?.label === 'persona',
      `n=${blocksDetail.length} first=${String(blocksDetail[0]?.label)}`,
    );

    const termList = await listTerms(ctx, userId, { pageSize: 20 });
    check('词列表可用', termList.total >= 1, `total=${termList.total}`);

    const candidates = await listCandidates(ctx, userId, 'pending');
    check('待审队列可查', Array.isArray(candidates), `n=${candidates.length}`);

    const audits = await listAudit(ctx, userId, { limit: 20 });
    check('审计可查', audits.length >= 1, `n=${audits.length}`);

    const graphView = await graphData(ctx, userId, { limit: 100 });
    check('词图视图可用', graphView.nodes.length >= 1, `nodes=${graphView.nodes.length}`);

    // 物理清除 → 回收站 → 快照回灌：SQLite 没有 setval，靠 AUTOINCREMENT 自己跳过
    const doomed = await write(ctx, {
      messages: [
        { role: 'user', content: '这条只用来验证回收站和快照回灌。' },
        { role: 'assistant', content: '好，稍后删掉再恢复。' },
      ],
      close: true,
      scope: 'sqlite-trash',
      card: {
        summary:
          '回收站验证用的临时卡片：物理清除后应进入回收站，七天内可从快照回灌恢复，恢复后标识与内容保持不变。',
        keywords: ['回收站', '快照'],
        intent: '信息同步',
      },
    });
    const purged = await forget(ctx, {
      userId,
      target: { type: 'card', id: doomed.card_id as number },
      mode: 'purge',
      confirm: true,
      actor: 'human',
    });
    const trash = await listTrash(ctx, userId);
    check(
      '物理清除后回收站可见',
      trash.some((item) => item.id === purged.trash_id),
      `trash=${trash.length}`,
    );

    await restoreSnapshot(ctx, userId, purged.trash_id as number, 'human');
    const afterRestore = await listCards(ctx, userId, { pageSize: 100 });
    check(
      '快照回灌后卡片回来',
      afterRestore.items.some((item) => item.id === doomed.card_id),
      `card=${doomed.card_id}`,
    );

    const blockFix = await correct(ctx, {
      userId,
      target: { type: 'block', label: 'persona' },
      patch: { content: 'SQLite 验证用 persona：先给结论，再补要点（改块后需重载）。' },
      reason: 'sqlite 冒烟：验证常驻块写入的返回',
    });
    check(
      '改常驻块返回 reload_required',
      blockFix.reload_required === true,
      `version=${blockFix.version}`,
    );

    const sleep = await sleepReport(ctx, userId, 3);
    check(
      '睡眠清单在 SQLite 下可执行',
      ['low', 'medium', 'high'].includes(sleep.level) &&
        typeof sleep.counts.unfiled_raws === 'number' &&
        Array.isArray(sleep.queues.duplicates),
      `level=${sleep.level} unfiled=${sleep.counts.unfiled_raws} doubtful=${sleep.counts.doubtful}`,
    );

    // 造一条没挂卡的原文，验证「清单 → 分诊 → 清单不再出现」的闭环
    const orphan = await sql<Array<{ id: number }>>`
      INSERT INTO mem_raw (event_id, user_id, seq, role, content, ts, hash)
      VALUES (
        (SELECT id FROM mem_event WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1),
        ${userId}, 99, 'user',
        ${'这条原文故意不挂到任何卡上，用来验证整理清单与分诊闭环。'},
        ${new Date()}, 'smoke-triage-orphan'
      )
      RETURNING id`;
    const orphanId = Number(orphan[0]?.id);
    const beforeTriage = await sleepReport(ctx, userId, 5);
    const marked = await triageItems(
      ctx,
      userId,
      [{ type: 'raw', id: orphanId }],
      'mark',
      '冒烟：确认无需成卡',
    );
    const afterTriage = await sleepReport(ctx, userId, 5);
    check(
      '分诊后同一批不再列出',
      beforeTriage.queues.unfiled_raws.some((row) => row.raw_id === orphanId) &&
        marked.marked === 1 &&
        afterTriage.counts.unfiled_raws === beforeTriage.counts.unfiled_raws - 1,
      `before=${beforeTriage.counts.unfiled_raws} marked=${marked.marked} after=${afterTriage.counts.unfiled_raws}`,
    );

    const cleared = await triageItems(
      ctx,
      userId,
      [{ type: 'raw', id: orphanId }],
      'clear',
      '冒烟：撤销分诊',
    );
    const afterClear = await sleepReport(ctx, userId, 5);
    check(
      '撤销分诊后重新回到清单',
      cleared.cleared === 1 && afterClear.counts.unfiled_raws === beforeTriage.counts.unfiled_raws,
      `cleared=${cleared.cleared} unfiled=${afterClear.counts.unfiled_raws}`,
    );

    // 组合包用 HOOK_CHECK=off 关掉与客户端强绑定的钩子自检
    process.env.HOOK_CHECK = 'off';
    const noHook = await startPreview(ctx, userId);
    delete process.env.HOOK_CHECK;
    const withHook = await startPreview(ctx, userId);
    check(
      'HOOK_CHECK 开关控制钩子自检',
      noHook.hook_check === undefined && withHook.hook_check !== undefined,
      `off=${noHook.hook_check === undefined} on=${withHook.hook_check !== undefined}`,
    );

    const patrol = await runPatrol(ctx, userId);
    check('巡检在 SQLite 下可执行', typeof patrol.duration_ms === 'number', `evicted=${patrol.evicted}`);

    // 启动补跑：定时器等到下一个定时点，本机关机就永远不触发
    const patrolMark = () =>
      sql<Array<{ value: string }>>`
        SELECT value FROM app_setting
        WHERE user_id = ${userId} AND key = 'life.last_patrol_at'`;
    const mark1 = await patrolMark();
    check('巡检完成后落时间标记', Boolean(mark1[0]?.value), String(mark1[0]?.value ?? ''));

    await runPatrolIfStale(ctx, userId, () => {});
    const mark2 = await patrolMark();
    check(
      '24 小时内不重复补跑',
      mark2[0]?.value === mark1[0]?.value,
      `before=${mark1[0]?.value} after=${mark2[0]?.value}`,
    );

    await sql`DELETE FROM app_setting WHERE user_id = ${userId} AND key = 'life.last_patrol_at'`;
    await runPatrolIfStale(ctx, userId, () => {});
    const mark3 = await patrolMark();
    check('没有记录时启动会补跑一次', Boolean(mark3[0]?.value));

    const radial = await graphRadial(ctx, userId, {});
    check('径向图谱在 SQLite 下返回节点', radial.nodes.length > 0, `nodes=${radial.nodes.length}`);

    const failed = checks.filter((item) => !item.ok);
    console.log(`\n共 ${checks.length} 项 SQLite 检查，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await closeSql(sql);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: unknown) => {
    console.error('SQLite 冒烟失败：', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
