import { condenseEvent } from './memory.service.js';
import { recordEvent } from '../metrics.js';
import { OID, writeAudit, type Ctx } from './context.js';

export interface PatrolReport {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  partitions_created: number;
  condense: { attempted: number; succeeded: number; failed: number };
  /** 超过窗口仍未成卡的 open 事件：能成卡的浓缩，内容不足的归档（L3 原文保留），出错的排队重试 */
  open_events: { condensed: number; archived: number; queued: number };
  /** L1 经验条只由调用方经 MCP 写入；巡检仅做容量淘汰与闲置下线 */
  evicted: number;
  demotion: number;
  /** 待淡忘的候选数：压骨架改为睡觉时由 AI 判断，巡检只统计、不再执行 */
  decay_candidates: number;
  archived_raw: number;
  purged_raw: number;
  purged_trash: number;
  /** 受保护、不会被淡忘的卡数（重要 / 钉住 / 人物关系） */
  guards: { protected_cards: number };
}

let running = false;

/** 上次巡检完成时间，存 app_setting；用于开机补跑判断 */
export const PATROL_MARK_KEY = 'life.last_patrol_at';

export async function readLastPatrol(ctx: Ctx, userId: number): Promise<Date | null> {
  const rows = await ctx.sql<Array<{ value: string }>>`
    SELECT value FROM app_setting WHERE user_id = ${userId} AND key = ${PATROL_MARK_KEY}`;
  const raw = rows[0]?.value;
  if (!raw) return null;
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 历史值可能是裸 ISO，直接按字符串解析
  }
  const date = new Date(String(parsed));
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function markPatrolDone(ctx: Ctx, userId: number, at: Date): Promise<void> {
  await ctx.sql`
    INSERT INTO app_setting (user_id, key, value, updated_by, updated_at)
    VALUES (${userId}, ${PATROL_MARK_KEY}, ${JSON.stringify(at.toISOString())}, 'system', ${at})
    ON CONFLICT (user_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = 'system', updated_at = EXCLUDED.updated_at`;
}

/**
 * NFR-08：每日一次全量巡检。每个任务都是分批 + 幂等，可中断续跑；
 * 100 万卡规模下按批处理控制在分钟级。
 */
export async function runPatrol(ctx: Ctx, userId: number): Promise<PatrolReport> {
  if (running) {
    throw new Error('巡检正在进行中，请稍后重试');
  }
  running = true;
  const startedAt = ctx.now();
  const report: PatrolReport = {
    started_at: startedAt.toISOString(),
    finished_at: '',
    duration_ms: 0,
    partitions_created: 0,
    condense: { attempted: 0, succeeded: 0, failed: 0 },
    open_events: { condensed: 0, archived: 0, queued: 0 },
    evicted: 0,
    demotion: 0,
    decay_candidates: 0,
    archived_raw: 0,
    purged_raw: 0,
    purged_trash: 0,
    guards: { protected_cards: 0 },
  };

  try {
    report.partitions_created = await ensurePartitions(ctx);

    const condense = await retryCondenseJobs(ctx, userId);
    report.condense = condense;

    // 兜住"写进来但一直没成卡"的 open 事件：写入路径已经会续写，这里负责清理历史遗留
    report.open_events = await sweepOpenEvents(ctx, userId);

    // 技能条目只由调用方经 MCP 写入：巡检不再自动固化，也不生成技能候选
    report.evicted = await evictOverflow(ctx, userId);
    report.demotion = await demoteIdleBlocks(ctx, userId);
    report.decay_candidates = await countDecayCandidates(ctx, userId, report);
    report.archived_raw = await archiveRaw(ctx);
    report.purged_raw = await purgeExpiredRaw(ctx, userId);
    report.purged_trash = await purgeTrash(ctx);
  } finally {
    running = false;
  }

  const finishedAt = ctx.now();
  report.finished_at = finishedAt.toISOString();
  report.duration_ms = finishedAt.getTime() - startedAt.getTime();
  // 只有跑完才落标记：中途抛异常不算完成，下次启动会重新补跑
  await markPatrolDone(ctx, userId, finishedAt);
  await writeAudit(ctx, {
    userId,
    objectType: 'lifecycle',
    objectId: 0,
    op: 'patrol',
    after: report as unknown as Record<string, unknown>,
    actor: 'system',
    reason: '每日全量巡检',
  });
  return report;
}

async function ensurePartitions(ctx: Ctx): Promise<number> {
  // SQLite 没有分区表：mem_raw 就是一张普通表，预建分区只在 PG 有意义
  if (ctx.sql.dialect === 'sqlite') return 0;
  const now = ctx.now();
  let created = 0;
  for (let offset = 0; offset <= 2; offset++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const name = `mem_raw_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    const exists = await ctx.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_class WHERE relname = ${name}`;
    if (Number(exists[0]?.n ?? 0) > 0) continue;
    await ctx.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF mem_raw FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
    );
    created += 1;
  }
  return created;
}

async function retryCondenseJobs(
  ctx: Ctx,
  userId: number,
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const jobs = await ctx.sql<Array<{ event_id: number; attempts: number }>>`
    SELECT event_id, attempts FROM condense_job
    WHERE status = 'pending' AND next_at <= ${ctx.now()}
    ORDER BY next_at
    LIMIT 20`;
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await condenseEvent(ctx, userId, Number(job.event_id), { actor: 'system' });
      succeeded += 1;
      recordEvent(true);
    } catch (err) {
      failed += 1;
      recordEvent(false, true);
      const attempts = Number(job.attempts) + 1;
      const maxAttempts = ctx.cfg.write.condenseMaxAttempts;
      const backoffMs = Math.min(60 * 60_000, 2 ** attempts * 30_000);
      await ctx.sql`
        UPDATE condense_job SET
          attempts = ${attempts},
          next_at = ${new Date(ctx.now().getTime() + backoffMs)},
          last_error = ${err instanceof Error ? err.message : String(err)},
          status = ${attempts >= maxAttempts ? 'failed' : 'pending'}
        WHERE event_id = ${job.event_id}`;
      if (attempts >= maxAttempts) {
        // 超过重试上限转人工队列
        await ctx.sql`
          INSERT INTO promotion_candidate (user_id, kind, payload, evidence, score, dedupe_key)
          VALUES (
            ${userId}, 'skill',
            ${ctx.sql.json({ reason: 'condense_failed', event_id: Number(job.event_id) } as never)},
            ${ctx.sql.array([Number(job.event_id)], OID.int8)}, 0,
            ${`condense:${job.event_id}`}
          )
          ON CONFLICT DO NOTHING`;
      }
    }
  }
  return { attempted: jobs.length, succeeded, failed };
}

/** 单次巡检最多处理多少个遗留 open 事件，避免一次拉太多原文进内存 */
const OPEN_EVENT_SWEEP_LIMIT = 50;

/**
 * 有效内容不足该字符数的遗留事件不值得成卡：
 * 规则浓缩会给短内容补一句"内容较短"的占位摘要，成卡只会往库里塞噪声。
 */
const OPEN_EVENT_MIN_CHARS = 20;

/**
 * 兜底：把超过窗口仍未成卡的 open 事件收口。
 * - 有效内容够：直接浓缩成卡（规则式，无模型）；
 * - 有效内容太少（如只剩一句"嗯"）：归档，L3 原文保留，可人工恢复；
 * - 浓缩出错：登记 condense_job 走既有的指数退避重试，不在这里归档。
 */
async function sweepOpenEvents(
  ctx: Ctx,
  userId: number,
): Promise<{ condensed: number; archived: number; queued: number }> {
  const stats = { condensed: 0, archived: 0, queued: 0 };
  const hours = ctx.cfg.write.openEventSweepHours;
  if (!(hours > 0)) return stats;

  const cutoff = new Date(ctx.now().getTime() - hours * 3_600_000);
  const rows = await ctx.sql<Array<{ id: number; chars: number }>>`
    SELECT e.id,
           COALESCE(SUM(CASE WHEN r.role IN ('user', 'assistant') THEN length(r.content) ELSE 0 END), 0) AS chars
    FROM mem_event e
    LEFT JOIN mem_raw r ON r.event_id = e.id
    WHERE e.user_id = ${userId}
      AND e.status = 'open'
      AND e.started_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM mem_card c WHERE c.event_id = e.id AND c.deleted_at IS NULL
      )
    GROUP BY e.id
    ORDER BY e.id ASC
    LIMIT ${OPEN_EVENT_SWEEP_LIMIT}`;

  for (const row of rows) {
    const eventId = Number(row.id);
    if (Number(row.chars) < OPEN_EVENT_MIN_CHARS) {
      await ctx.sql`
        UPDATE mem_event SET status = 'archived', ended_at = COALESCE(ended_at, ${ctx.now()})
        WHERE id = ${eventId}`;
      stats.archived += 1;
      continue;
    }
    try {
      await condenseEvent(ctx, userId, eventId, { actor: 'system' });
      stats.condensed += 1;
      recordEvent(true);
    } catch (err) {
      await ctx.sql`
        INSERT INTO condense_job (event_id, attempts, next_at, last_error, status)
        VALUES (${eventId}, 0, ${ctx.now()}, ${err instanceof Error ? err.message : String(err)}, 'pending')
        ON CONFLICT (event_id) DO NOTHING`;
      stats.queued += 1;
    }
  }
  return stats;
}

/*
 * 技能条目（skills）只允许调用方经 MCP 写入：
 * 巡检不再自动固化，也不再生成 skill 候选，只保留容量淘汰与闲置下线。
 */

/** 按词经验最多留这么多条；正文长度另有 char_limit 管，不在这里重复掐 */
const MAX_SKILL_ENTRIES = 30;

/**
 * L1 是容量受限的缓存，但只按条数淘汰。
 * 原先按正文 token 淘汰，等于给「写得详细」判死刑：正文根本不在常驻上下文里，
 * 真正占预算的是索引，那部分由 buildSkillIndex 的 maxTokens 管。
 */
async function evictOverflow(ctx: Ctx, userId: number): Promise<number> {
  const rows = await ctx.sql<Array<{ id: number; slot: string; content: string; heat: number }>>`
    SELECT id, slot, content, heat FROM mem_block
    WHERE user_id = ${userId} AND label = 'skills' AND slot LIKE 'skill:%' AND deleted_at IS NULL
    ORDER BY heat DESC`;
  const excess = Math.max(0, rows.length - MAX_SKILL_ENTRIES);
  let evicted = 0;
  for (let i = rows.length - 1; i >= 0 && evicted < excess; i--) {
    const row = rows[i];
    if (!row) continue;
    await ctx.sql`UPDATE mem_block SET deleted_at = ${ctx.now()} WHERE id = ${row.id}`;
    await writeAudit(ctx, {
      userId,
      objectType: 'block',
      objectId: Number(row.id),
      op: 'evict',
      before: { slot: row.slot, content: row.content, heat: Number(row.heat) },
      actor: 'system',
      reason: `经验条数超过 ${MAX_SKILL_ENTRIES} 条，淘汰最冷条目回落 L2`,
    });
    evicted += 1;
  }
  return evicted;
}

/** L1 经验 90 天未使用 → 下线（来源卡不动）。重新入库需调用方经 MCP 再写。 */
async function demoteIdleBlocks(ctx: Ctx, userId: number): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.cfg.life.l1IdleDemoteDays * 86_400_000);
  const rows = await ctx.sql<Array<{ id: number; slot: string; content: string; heat: number }>>`
    SELECT id, slot, content, heat FROM mem_block
    WHERE user_id = ${userId} AND label = 'skills' AND slot LIKE 'skill:%' AND deleted_at IS NULL
      AND COALESCE(last_used_at, created_at) < ${cutoff}`;
  for (const row of rows) {
    await ctx.sql`UPDATE mem_block SET deleted_at = ${ctx.now()} WHERE id = ${row.id}`;
    await writeAudit(ctx, {
      userId,
      objectType: 'block',
      objectId: Number(row.id),
      op: 'demote',
      before: { slot: row.slot, content: row.content },
      actor: 'system',
      reason: 'L1 经验 90 天未使用，下线（重新写入需调用方经 MCP）',
    });
  }
  return rows.length;
}

/**
 * FR-16 的候选统计。
 * 压骨架要断开原文、不可逆，属于「这条还有没有价值」的判断，
 * 交给 memory.sleep 时由调用方决定；巡检只报数，不改数据。
 */
async function countDecayCandidates(
  ctx: Ctx,
  userId: number,
  report: PatrolReport,
): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.cfg.life.coldDays * 86_400_000);
  const candidates = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM mem_card
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND is_skeleton = false
      AND status = 'ready'
      AND pinned = false
      AND category <> 'person'
      AND importance < 0.8
      AND heat < ${ctx.cfg.life.coldHeat}
      -- 反复被召回说明持续相关，只是没被采用：压成骨架等于把还在用的线索删了
      AND hit_count < 3
      AND COALESCE(last_hit_at, created_at) < ${cutoff}`;

  const protectedRows = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM mem_card
    WHERE user_id = ${userId} AND deleted_at IS NULL AND is_skeleton = false
      AND (importance >= 0.8 OR pinned = true OR category = 'person')`;
  report.guards.protected_cards += Number(protectedRows[0]?.n ?? 0);
  return Number(candidates[0]?.n ?? 0);
}

/** FR-04：L3 保留 12 个月后归档，归档后仍可按 ID 取回。 */
async function archiveRaw(ctx: Ctx): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.cfg.life.rawArchiveDays * 86_400_000);
  // 拆成先读后写：数据修改型 CTE 只有 PG 支持
  const batch = await ctx.sql<Array<{ id: number }>>`
    SELECT id FROM mem_raw
    WHERE ts < ${cutoff} AND archived_at IS NULL
    LIMIT 5000`;
  if (batch.length === 0) return 0;
  await ctx.sql`
    UPDATE mem_raw SET archived_at = ${ctx.now()}
    WHERE id IN (${batch.map((row) => Number(row.id))})`;
  return batch.length;
}

/** FR-16：归档满 24 个月后物理清除，清除前先进回收站（7 天内可恢复）。 */
async function purgeExpiredRaw(ctx: Ctx, userId: number): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - ctx.cfg.life.rawPurgeDays * 86_400_000);
  const rows = await ctx.sql<Array<Record<string, unknown> & { id: number; ts: Date }>>`
    SELECT id, event_id, user_id, seq, role, content, ts, archived_at FROM mem_raw
    WHERE archived_at IS NOT NULL AND ts < ${cutoff}
    LIMIT 100`;
  let purged = 0;
  const purgeAt = new Date(ctx.now().getTime() + ctx.cfg.life.trashRestoreDays * 86_400_000);
  for (const raw of rows) {
    await ctx.sql`
      INSERT INTO mem_trash (user_id, object_type, object_id, snapshot, deleted_by, purge_at)
      VALUES (
        ${userId}, 'raw', ${raw.id},
        ${ctx.sql.json({ raw } as never)}, 'system', ${purgeAt}
      )`;
    await ctx.sql`DELETE FROM mem_raw WHERE id = ${raw.id} AND ts = ${new Date(raw.ts)}`;
    purged += 1;
  }
  return purged;
}

async function purgeTrash(ctx: Ctx): Promise<number> {
  const expired = await ctx.sql<Array<{ id: number }>>`
    SELECT id FROM mem_trash WHERE restored_at IS NULL AND purge_at < ${ctx.now()}`;
  if (expired.length === 0) return 0;
  await ctx.sql`DELETE FROM mem_trash WHERE id IN (${expired.map((row) => Number(row.id))})`;
  return expired.length;
}
