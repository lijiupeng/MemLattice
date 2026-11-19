import { diceSimilarity } from '../core/text.js';
import type { FragmentParam } from '../db/client.js';
import type { Ctx } from './context.js';

export type PressureLevel = 'low' | 'medium' | 'high';

/**
 * 阈值取「明显积压」而不是「刚开始积累」：轻度积累每次都报警，
 * 会让 AI 反复整理同一批东西，压力永远降不下去。
 */
const RULES = {
  unfiledRaw: 50,
  openEvents: 5,
  openEventHours: 2,
  unsolidified: 3,
  duplicatePairs: 3,
  doubtful: 5,
  fading: 10,
  /** 用 df（出现在多少张卡里）衡量主题分量；词热度只代表被召回次数，几乎人人都会攒到 */
  hotDf: 5,
  duplicateGroupCards: 5,
  pairSimilarity: 0.6,
  /** 快速估算时最多扫几组，避免会话初始化被大量相似度计算拖慢 */
  scanGroups: 3,
} as const;

const DAY = 86_400_000;

export interface PressureCounts {
  /** 还没挂到任何卡上的原文条数 */
  unfiled_raws: number;
  /** 开着没收口的事件数 */
  open_events: number;
  /** 热度够高却没有对应经验块的主题数 */
  unsolidified: number;
  /** 摘要相似度超过阈值的卡片对数量：与明细同口径 */
  duplicate_pairs: number;
  /** 置信度低、或从未被用过的卡 */
  doubtful: number;
  /** 已经接近淡忘的卡 */
  fading: number;
}

export interface Pressure {
  level: PressureLevel;
  counts: PressureCounts;
  /** 按严重程度排的说明，直接给人看 */
  reasons: string[];
  /** 给会话初始化用的一句话 */
  hint: string;
}

export interface SleepReport extends Pressure {
  l1: { skills: number; limit: number };
  queues: {
    unfiled_raws: Array<{ raw_id: number; event_id: number; seq: number; role: string; ts: Date; preview: string }>;
    open_events: Array<{ event_id: number; session_id: string | null; started_at: Date; raws: number }>;
    unsolidified: Array<{ term_id: number; name: string; df: number; card_count: number }>;
    duplicates: Array<{
      term_id: number;
      name: string;
      pairs: Array<{ a: number; b: number; similarity: number; a_summary: string; b_summary: string }>;
    }>;
    doubtful: Array<{
      card_id: number;
      summary: string;
      confidence: number;
      use_count: number;
      hit_count: number;
    }>;
    fading: Array<{ card_id: number; summary: string; heat: number; last_hit_at: Date | null }>;
  };
}

function decide(counts: PressureCounts): { level: PressureLevel; reasons: string[]; hint: string } {
  const reasons: string[] = [];
  if (counts.unfiled_raws >= RULES.unfiledRaw) {
    reasons.push(`${counts.unfiled_raws} 条原文还没成卡`);
  }
  if (counts.open_events >= RULES.openEvents) {
    reasons.push(`${counts.open_events} 个事件开着没收口`);
  }
  if (counts.unsolidified >= RULES.unsolidified) {
    reasons.push(`${counts.unsolidified} 个高频主题还没提炼成经验`);
  }
  if (counts.duplicate_pairs >= RULES.duplicatePairs) {
    reasons.push(`${counts.duplicate_pairs} 对卡片摘要高度相似`);
  }
  if (counts.doubtful >= RULES.doubtful) {
    reasons.push(`${counts.doubtful} 张卡置信度低或从未被用过`);
  }
  if (counts.fading >= RULES.fading) {
    reasons.push(`${counts.fading} 张卡接近淡忘`);
  }

  const level: PressureLevel = reasons.length >= 3 ? 'high' : reasons.length >= 1 ? 'medium' : 'low';
  const hint =
    level === 'low'
      ? '记忆没有明显积压'
      : `有 ${reasons.length} 项待整理：${reasons[0] ?? ''}`;
  return { level, reasons, hint };
}

export type TriageType = 'raw' | 'term' | 'card';

export interface TriageItem {
  type: TriageType;
  id: number;
}

/**
 * 把清单里判断过、决定不处理的项记下来。只影响清单，不动记忆本身。
 * 没有这层记录，每次睡觉都要重新看同一批误报。
 * clear 用来撤销：标错了必须能退回来，否则一次误判就永久静音。
 */
export async function triageItems(
  ctx: Ctx,
  userId: number,
  items: readonly TriageItem[],
  mode: 'mark' | 'clear',
  reason?: string,
): Promise<{ marked: number; cleared: number }> {
  if (items.length === 0) return { marked: 0, cleared: 0 };

  if (mode === 'mark') {
    const rows = items.map((item) => [
      userId,
      item.type,
      Number(item.id),
      reason ?? null,
      ctx.now(),
    ]);
    const inserted = await ctx.sql<Array<{ object_id: number }>>`
      INSERT INTO mem_triage (user_id, object_type, object_id, reason, created_at)
      VALUES ${ctx.sql.values(rows)}
      ON CONFLICT (user_id, object_type, object_id) DO NOTHING
      RETURNING object_id`;
    return { marked: inserted.length, cleared: 0 };
  }

  let cleared = 0;
  for (const type of ['raw', 'term', 'card'] as const) {
    const ids = items.filter((item) => item.type === type).map((item) => Number(item.id));
    if (ids.length === 0) continue;
    const removed = await ctx.sql<Array<{ object_id: number }>>`
      DELETE FROM mem_triage
      WHERE user_id = ${userId} AND object_type = ${type} AND object_id IN (${ids})
      RETURNING object_id`;
    cleared += removed.length;
  }
  return { marked: 0, cleared };
}

/** 该词是否已被某条经验通过 ref_terms 引用：两个后端的数组存储方式不同 */
function coveredByExperience(ctx: Ctx): FragmentParam {
  return ctx.sql.dialect === 'pg'
    ? ctx.sql.fragment`EXISTS (
        SELECT 1 FROM mem_block b
        WHERE b.user_id = t.user_id AND b.label = 'skills' AND b.deleted_at IS NULL
          AND t.id = ANY(b.ref_terms)
      )`
    : ctx.sql.fragment`EXISTS (
        SELECT 1 FROM mem_block b
        WHERE b.user_id = t.user_id AND b.label = 'skills' AND b.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM json_each(b.ref_terms) je WHERE je.value = t.id)
      )`;
}

interface DuplicateGroup {
  term_id: number;
  name: string;
  pairs: Array<{ a: number; b: number; similarity: number; a_summary: string; b_summary: string }>;
}

/**
 * 压力与明细共用同一份计算。两处口径不一致时，人会先看到「4 组可能重复」，
 * 翻开清单却一对都没有，之后就再也不信这个数字了。
 */
async function findDuplicateGroups(
  ctx: Ctx,
  userId: number,
  groupLimit: number,
): Promise<DuplicateGroup[]> {
  const groups = await ctx.sql<Array<{ term_id: number; name: string; n: number }>>`
    SELECT ct.term_id, t.name, count(*) AS n
    FROM card_term ct
    JOIN mem_card c ON c.id = ct.card_id
    JOIN term t ON t.id = ct.term_id
    WHERE c.user_id = ${userId} AND c.deleted_at IS NULL
      AND c.is_skeleton = false AND c.status = 'ready' AND t.deleted_at IS NULL
    GROUP BY ct.term_id, t.name
    HAVING count(*) >= ${RULES.duplicateGroupCards}
    ORDER BY n DESC LIMIT ${groupLimit}`;

  const out: DuplicateGroup[] = [];
  for (const group of groups) {
    const cards = await ctx.sql<Array<{ id: number; summary: string }>>`
      SELECT c.id, c.summary
      FROM card_term ct JOIN mem_card c ON c.id = ct.card_id
      WHERE ct.term_id = ${group.term_id} AND c.user_id = ${userId}
        AND c.deleted_at IS NULL AND c.is_skeleton = false AND c.status = 'ready'
      ORDER BY c.heat DESC LIMIT 5`;
    const pairs: DuplicateGroup['pairs'] = [];
    for (let i = 0; i < cards.length; i += 1) {
      for (let j = i + 1; j < cards.length; j += 1) {
        const left = cards[i];
        const right = cards[j];
        if (!left || !right) continue;
        const similarity = diceSimilarity(left.summary, right.summary);
        if (similarity < RULES.pairSimilarity) continue;
        pairs.push({
          a: Number(left.id),
          b: Number(right.id),
          similarity: Math.round(similarity * 100) / 100,
          a_summary: left.summary.slice(0, 60),
          b_summary: right.summary.slice(0, 60),
        });
      }
    }
    if (pairs.length > 0) out.push({ term_id: Number(group.term_id), name: group.name, pairs });
  }
  return out;
}

/** 只算数量：会话初始化每轮都会调，不能带明细 */
export async function sleepPressure(
  ctx: Ctx,
  userId: number,
  knownPairs?: number,
): Promise<Pressure> {
  const now = ctx.now();
  const openCutoff = new Date(now.getTime() - RULES.openEventHours * 3_600_000);
  const unusedCutoff = new Date(now.getTime() - 7 * DAY);
  const coldCutoff = new Date(now.getTime() - ctx.cfg.life.coldDays * DAY);

  const covered = coveredByExperience(ctx);
  const rows = await ctx.sql<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*) FROM mem_raw r
        WHERE r.user_id = ${userId}
          AND NOT EXISTS (SELECT 1 FROM card_raw cr WHERE cr.raw_id = r.id)
          AND NOT EXISTS (
            SELECT 1 FROM mem_triage mt
            WHERE mt.user_id = ${userId} AND mt.object_type = 'raw' AND mt.object_id = r.id
          )) AS unfiled_raws,
      (SELECT count(*) FROM mem_event e
        WHERE e.user_id = ${userId} AND e.status = 'open'
          AND e.started_at < ${openCutoff}) AS open_events,
      (SELECT count(*) FROM term t
        WHERE t.user_id = ${userId} AND t.deleted_at IS NULL
          AND t.kind <> 'intent' AND t.df >= ${RULES.hotDf}
          AND NOT EXISTS (
            SELECT 1 FROM mem_block b
            WHERE b.user_id = t.user_id AND b.label = 'skills'
              AND b.slot = ('skill:' || CAST(t.id AS TEXT)) AND b.deleted_at IS NULL
          )
          AND NOT ${covered}
          AND NOT EXISTS (
            SELECT 1 FROM mem_triage mt
            WHERE mt.user_id = ${userId} AND mt.object_type = 'term' AND mt.object_id = t.id
          )) AS unsolidified,
      (SELECT count(*) FROM mem_card c
        WHERE c.user_id = ${userId} AND c.deleted_at IS NULL
          AND (c.confidence < 0.5 OR (c.use_count = 0 AND c.created_at < ${unusedCutoff}))
          AND NOT EXISTS (
            SELECT 1 FROM mem_triage mt
            WHERE mt.user_id = ${userId} AND mt.object_type = 'card' AND mt.object_id = c.id
          )) AS doubtful,
      (SELECT count(*) FROM mem_card c
        WHERE c.user_id = ${userId} AND c.deleted_at IS NULL
          AND c.is_skeleton = false AND c.status = 'ready' AND c.pinned = false
          AND c.category <> 'person' AND c.importance < 0.8
          AND c.heat < ${ctx.cfg.life.coldHeat} AND c.hit_count < 3
          AND COALESCE(c.last_hit_at, c.created_at) < ${coldCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM mem_triage mt
            WHERE mt.user_id = ${userId} AND mt.object_type = 'card' AND mt.object_id = c.id
          )) AS fading`;

  const duplicatePairs =
    knownPairs ??
    (await findDuplicateGroups(ctx, userId, RULES.scanGroups)).reduce(
      (sum, group) => sum + group.pairs.length,
      0,
    );

  const row = rows[0] ?? {};
  const counts: PressureCounts = {
    unfiled_raws: Number(row.unfiled_raws ?? 0),
    open_events: Number(row.open_events ?? 0),
    unsolidified: Number(row.unsolidified ?? 0),
    duplicate_pairs: duplicatePairs,
    doubtful: Number(row.doubtful ?? 0),
    fading: Number(row.fading ?? 0),
  };
  return { counts, ...decide(counts) };
}

/**
 * 整理清单：只读，不写任何东西。
 * 具体的合并、提炼、修正、淡化由调用方按这份清单自己决定。
 */
export async function sleepReport(ctx: Ctx, userId: number, limit = 5): Promise<SleepReport> {
  const take = Math.max(1, Math.min(limit, 20));
  const duplicateGroups = await findDuplicateGroups(ctx, userId, take);
  const pressure = await sleepPressure(
    ctx,
    userId,
    duplicateGroups.reduce((sum, group) => sum + group.pairs.length, 0),
  );
  const now = ctx.now();
  const openCutoff = new Date(now.getTime() - RULES.openEventHours * 3_600_000);
  const unusedCutoff = new Date(now.getTime() - 7 * DAY);
  const coldCutoff = new Date(now.getTime() - ctx.cfg.life.coldDays * DAY);
  const covered = coveredByExperience(ctx);

  const [unfiled, opened, unsolidified, doubtful, fading, skills] = await Promise.all([
    ctx.sql<Array<{ raw_id: number; event_id: number; seq: number; role: string; ts: Date; preview: string }>>`
      SELECT r.id AS raw_id, r.event_id, r.seq, r.role, r.ts, substr(r.content, 1, 80) AS preview
      FROM mem_raw r
      WHERE r.user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM card_raw cr WHERE cr.raw_id = r.id)
        AND NOT EXISTS (
          SELECT 1 FROM mem_triage mt
          WHERE mt.user_id = ${userId} AND mt.object_type = 'raw' AND mt.object_id = r.id
        )
      ORDER BY r.ts DESC LIMIT ${take}`,
    ctx.sql<Array<{ event_id: number; session_id: string | null; started_at: Date; raws: number }>>`
      SELECT e.id AS event_id, e.session_id, e.started_at,
             (SELECT count(*) FROM mem_raw r WHERE r.event_id = e.id) AS raws
      FROM mem_event e
      WHERE e.user_id = ${userId} AND e.status = 'open' AND e.started_at < ${openCutoff}
      ORDER BY e.started_at ASC LIMIT ${take}`,
    ctx.sql<Array<{ term_id: number; name: string; df: number; card_count: number }>>`
      SELECT t.id AS term_id, t.name, t.df,
             (SELECT count(*) FROM card_term ct WHERE ct.term_id = t.id) AS card_count
      FROM term t
      WHERE t.user_id = ${userId} AND t.deleted_at IS NULL
        AND t.kind <> 'intent' AND t.df >= ${RULES.hotDf}
        AND NOT EXISTS (
          SELECT 1 FROM mem_block b
          WHERE b.user_id = t.user_id AND b.label = 'skills'
            AND b.slot = ('skill:' || CAST(t.id AS TEXT)) AND b.deleted_at IS NULL
        )
        AND NOT ${covered}
        AND NOT EXISTS (
          SELECT 1 FROM mem_triage mt
          WHERE mt.user_id = ${userId} AND mt.object_type = 'term' AND mt.object_id = t.id
        )
      ORDER BY t.df DESC LIMIT ${take}`,
    ctx.sql<
      Array<{
        card_id: number;
        summary: string;
        confidence: number;
        use_count: number;
        hit_count: number;
      }>
    >`
      SELECT id AS card_id, summary, confidence, use_count, hit_count
      FROM mem_card
      WHERE user_id = ${userId} AND deleted_at IS NULL
        AND (confidence < 0.5 OR (use_count = 0 AND created_at < ${unusedCutoff}))
        AND NOT EXISTS (
          SELECT 1 FROM mem_triage mt
          WHERE mt.user_id = ${userId} AND mt.object_type = 'card' AND mt.object_id = mem_card.id
        )
      ORDER BY confidence ASC, created_at ASC LIMIT ${take}`,
    ctx.sql<Array<{ card_id: number; summary: string; heat: number; last_hit_at: Date | null }>>`
      SELECT id AS card_id, summary, heat, last_hit_at
      FROM mem_card
      WHERE user_id = ${userId} AND deleted_at IS NULL
        AND is_skeleton = false AND status = 'ready' AND pinned = false
        AND category <> 'person' AND importance < 0.8
        AND heat < ${ctx.cfg.life.coldHeat} AND hit_count < 3
        AND COALESCE(last_hit_at, created_at) < ${coldCutoff}
        AND NOT EXISTS (
          SELECT 1 FROM mem_triage mt
          WHERE mt.user_id = ${userId} AND mt.object_type = 'card' AND mt.object_id = mem_card.id
        )
      ORDER BY heat ASC LIMIT ${take}`,
    ctx.sql<Array<{ n: number }>>`
      SELECT count(*) AS n FROM mem_block
      WHERE user_id = ${userId} AND label = 'skills' AND deleted_at IS NULL`,
  ]);


  return {
    ...pressure,
    l1: { skills: Number(skills[0]?.n ?? 0), limit: ctx.cfg.life.skillIndexLimit },
    queues: {
      unfiled_raws: unfiled.map((row) => ({ ...row, raw_id: Number(row.raw_id), event_id: Number(row.event_id), seq: Number(row.seq) })),
      open_events: opened.map((row) => ({ ...row, event_id: Number(row.event_id), raws: Number(row.raws) })),
      unsolidified: unsolidified.map((row) => ({
        ...row,
        term_id: Number(row.term_id),
        df: Number(row.df),
        card_count: Number(row.card_count),
      })),
      duplicates: duplicateGroups,
      doubtful: doubtful.map((row) => ({
        ...row,
        card_id: Number(row.card_id),
        confidence: Math.round(Number(row.confidence) * 100) / 100,
        use_count: Number(row.use_count),
        hit_count: Number(row.hit_count),
      })),
      fading: fading.map((row) => ({
        ...row,
        card_id: Number(row.card_id),
        heat: Math.round(Number(row.heat) * 100) / 100,
      })),
    },
  };
}
