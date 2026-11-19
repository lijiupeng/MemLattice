import { AppError } from '../core/errors.js';
import { clusterGraph, type GraphCluster } from '../core/cluster.js';
import { daysBetween } from '../core/heat.js';
import { clampText, normalize, uniq } from '../core/text.js';
import { estimateTokens } from '../core/tokens.js';
import { buildSkillEntry } from '../core/skill.js';
import { mergeTermInto } from './indexing.js';
import { markStaleByTerm } from './memory.service.js';
import { heatNow, OID, saveVersion, writeAudit, type Actor, type Ctx } from './context.js';

export interface CardListQuery {
  q?: string;
  term?: string;
  intent?: string;
  /** 场景维度：mem_event.session_id */
  scope?: string;
  from?: string;
  to?: string;
  staleOnly?: boolean;
  includeSkeleton?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CardListItem {
  id: number;
  event_id: number;
  summary: string;
  intent: string | null;
  keywords: string[];
  entities: string[];
  importance: number;
  heat: number;
  status: string;
  source: string;
  category: string;
  version: number;
  is_skeleton: boolean;
  stale: boolean;
  created_at: Date;
  raw_count: number;
  /** 0–1：被 feedback 判错会下调 */
  confidence: number;
  /** 被采用的次数 */
  use_count: number;
  /** 被召回的次数（只算曝光） */
  hit_count: number;
}

export async function listCards(
  ctx: Ctx,
  userId: number,
  query: CardListQuery = {},
): Promise<{ items: CardListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Number(query.pageSize ?? 20), 100));
  const q = (query.q ?? '').trim();
  const term = (query.term ?? '').trim();
  const intent = (query.intent ?? '').trim();
  const scope = (query.scope ?? '').trim();
  const like = `%${q}%`;
  const termLike = `%${term}%`;
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;

  // ILIKE / position / unnest 都是 PG 专有写法，SQLite 用 lower+LIKE、instr、json_each
  const summaryHit =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`(c.summary ILIKE ${like}
          OR EXISTS (SELECT 1 FROM unnest(c.keywords) AS k WHERE k ILIKE ${like})
          OR EXISTS (SELECT 1 FROM unnest(c.entities) AS e WHERE e ILIKE ${like}))`
      : ctx.sql.fragment`(lower(c.summary) LIKE lower(${like})
          OR EXISTS (SELECT 1 FROM json_each(c.keywords) AS k WHERE lower(k.value) LIKE lower(${like}))
          OR EXISTS (SELECT 1 FROM json_each(c.entities) AS e WHERE lower(e.value) LIKE lower(${like})))`;
  const termHit =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`(position(lower(${term}) in lower(t.name)) > 0
          OR t.aliases && ${ctx.sql.array([normalize(term)], OID.text)})`
      : ctx.sql.fragment`(instr(lower(t.name), lower(${term})) > 0
          OR EXISTS (SELECT 1 FROM json_each(t.aliases) AS ta WHERE lower(ta.value) = lower(${normalize(term)})))`;

  const filter = ctx.sql.fragment`
    c.user_id = ${userId}
    AND c.deleted_at IS NULL
    AND (${q === ''} OR ${summaryHit})
    AND (${term === ''} OR EXISTS (
          SELECT 1 FROM card_term ct JOIN term t ON t.id = ct.term_id
          WHERE ct.card_id = c.id AND ${termHit}
        ))
    AND (${intent === ''} OR c.intent = ${intent})
    AND (${scope === ''} OR EXISTS (
          SELECT 1 FROM mem_event e WHERE e.id = c.event_id AND e.session_id = ${scope}
        ))
    AND (${from === null} OR c.created_at >= ${from})
    AND (${to === null} OR c.created_at <= ${to})
    AND (${query.staleOnly !== true} OR c.stale_at IS NOT NULL)
    AND (${query.includeSkeleton === true} OR c.is_skeleton = false)`;

  const rows = await ctx.sql<CardListItem[]>`
    SELECT c.id, c.event_id, c.summary, c.intent, c.keywords, c.entities, c.importance,
           c.heat, c.status, c.source, c.category, c.version, c.is_skeleton,
           c.confidence, c.use_count, c.hit_count,
           (c.stale_at IS NOT NULL) AS stale, c.created_at,
           (SELECT count(*) FROM card_raw cr WHERE cr.card_id = c.id) AS raw_count
    FROM mem_card c
    WHERE ${filter}
    ORDER BY c.heat DESC, c.created_at DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

  const countRows = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM mem_card c WHERE ${filter}`;

  void termLike;
  return {
    items: rows.map((r) => ({
      ...r,
      id: Number(r.id),
      event_id: Number(r.event_id),
      importance: Number(r.importance),
      heat: round(Number(r.heat)),
      version: Number(r.version),
      confidence: Number(r.confidence ?? 0.8),
      use_count: Number(r.use_count ?? 0),
      hit_count: Number(r.hit_count ?? 0),
    })),
    total: Number(countRows[0]?.n ?? 0),
    page,
    pageSize,
  };
}

export interface CardDetail {
  card: Record<string, unknown>;
  terms: Array<{ id: number; name: string; kind: string; role: string; weight: number }>;
  raw_refs: Array<{
    raw_id: number;
    seq: number;
    role: string;
    content: string;
    ts: Date;
    archived: boolean;
    /** 属于哪个事件：同一事件内的 seq 才有意义 */
    event_id: number;
    event_started_at: Date | null;
    session_id: string | null;
  }>;
  versions: Array<{ version: number; snapshot: unknown; actor: string; created_at: Date }>;
  audit: Array<Record<string, unknown>>;
}

export async function getCardDetail(ctx: Ctx, userId: number, id: number): Promise<CardDetail> {
  const rows = await ctx.sql<Array<Record<string, unknown> & { id: number; is_skeleton: boolean }>>`
    SELECT * FROM mem_card WHERE id = ${id} AND user_id = ${userId}`;
  const card = rows[0];
  if (!card) throw new AppError('E_TARGET_NOT_FOUND', `卡 ${id} 不存在`);

  const [terms, raws, versions, audit] = await Promise.all([
    ctx.sql<Array<{ id: number; name: string; kind: string; role: string; weight: number }>>`
      SELECT t.id, t.name, t.kind, ct.role, ct.weight
      FROM card_term ct JOIN term t ON t.id = ct.term_id
      WHERE ct.card_id = ${id} AND t.deleted_at IS NULL
      ORDER BY ct.weight DESC`,
    card.is_skeleton
      ? Promise.resolve([])
      : ctx.sql<
          Array<{
            raw_id: number;
            seq: number;
            role: string;
            content: string;
            ts: Date;
            archived_at: Date | null;
            event_id: number;
            started_at: Date | null;
            session_id: string | null;
          }>
        >`
          SELECT cr.raw_id, r.seq, r.role, r.content, r.ts, r.archived_at,
                 r.event_id, e.started_at, e.session_id
          FROM card_raw cr
          JOIN mem_raw r ON r.id = cr.raw_id
          LEFT JOIN mem_event e ON e.id = r.event_id
          WHERE cr.card_id = ${id}
          ORDER BY r.event_id, r.seq
          LIMIT 50`,
    ctx.sql<Array<{ version: number; snapshot: unknown; actor: string; created_at: Date }>>`
      SELECT version, snapshot, actor, created_at FROM mem_version
      WHERE object_type = 'card' AND object_id = ${id}
      ORDER BY version DESC LIMIT 30`,
    ctx.sql<Array<Record<string, unknown>>>`
      SELECT id, op, actor, reason, before, after, created_at FROM mem_audit
      WHERE object_type = 'card' AND object_id = ${id}
      ORDER BY created_at DESC LIMIT 30`,
  ]);

  return {
    card: { ...card, id: Number(card.id) },
    terms: terms.map((t) => ({ ...t, id: Number(t.id), weight: Number(t.weight) })),
    raw_refs: raws.map((r) => ({
      raw_id: Number(r.raw_id),
      seq: Number(r.seq),
      role: r.role,
      content: r.content,
      ts: new Date(r.ts),
      archived: r.archived_at !== null,
      event_id: Number(r.event_id),
      event_started_at: r.started_at === null ? null : new Date(r.started_at),
      session_id: r.session_id,
    })),
    versions,
    audit,
  };
}

export interface TermListItem {
  id: number;
  name: string;
  kind: string;
  aliases: string[];
  df: number;
  heat: number;
  last_hit_at: Date | null;
  card_count: number;
}

export async function listTerms(
  ctx: Ctx,
  userId: number,
  query: { q?: string; kind?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: TermListItem[]; total: number }> {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Number(query.pageSize ?? 30), 200));
  const q = (query.q ?? '').trim();
  const like = `%${q}%`;
  const kind = (query.kind ?? '').trim();

  const termSearch =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`(t.name ILIKE ${like}
          OR EXISTS (SELECT 1 FROM unnest(t.aliases) a WHERE a ILIKE ${like}))`
      : ctx.sql.fragment`(lower(t.name) LIKE lower(${like})
          OR EXISTS (SELECT 1 FROM json_each(t.aliases) a WHERE lower(a.value) LIKE lower(${like})))`;

  const filter = ctx.sql.fragment`
    t.user_id = ${userId} AND t.deleted_at IS NULL
    AND (${q === ''} OR ${termSearch})
    AND (${kind === ''} OR t.kind = ${kind})`;

  const rows = await ctx.sql<TermListItem[]>`
    SELECT t.id, t.name, t.kind, t.aliases, t.df, t.heat, t.last_hit_at,
           (SELECT count(DISTINCT ct.card_id) FROM card_term ct WHERE ct.term_id = t.id) AS card_count
    FROM term t
    WHERE ${filter}
    ORDER BY t.heat DESC, t.df DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  const countRows = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM term t WHERE ${filter}`;

  return {
    items: rows.map((r) => ({
      ...r,
      id: Number(r.id),
      df: Number(r.df),
      heat: round(Number(r.heat)),
      card_count: Number(r.card_count),
      aliases: r.aliases ?? [],
    })),
    total: Number(countRows[0]?.n ?? 0),
  };
}

export async function mergeTerms(
  ctx: Ctx,
  userId: number,
  sourceId: number,
  targetId: number,
  actor: Actor = 'human',
): Promise<{ movedCards: number }> {
  if (sourceId === targetId) throw new AppError('E_INVALID', '不能把词合并到自身');
  const rows = await ctx.sql<Array<{ id: number; name: string }>>`
    SELECT id, name FROM term WHERE user_id = ${userId} AND deleted_at IS NULL AND id IN (${[sourceId, targetId]})`;
  if (rows.length < 2) throw new AppError('E_TARGET_NOT_FOUND', '源词或目标词不存在');

  const result = await mergeTermInto(ctx, sourceId, targetId);
  // FR-05 / 5.5：合并后引用旧词的卡标 stale，下次命中时重算
  const stale = await markStaleByTerm(ctx, targetId);
  await writeAudit(ctx, {
    userId,
    objectType: 'term',
    objectId: targetId,
    op: 'merge',
    before: { source_id: sourceId, target_id: targetId },
    after: { moved_cards: result.movedCards, stale_cards: stale },
    actor,
    reason: '同义词合并',
  });
  return result;
}

/* ------------------------------------------------------------------ graph */

export interface GraphNodeOut {
  id: string;
  label: string;
  kind: string;
  df: number;
  heat: number;
  degree: number;
  cluster: string;
}

export interface GraphEdgeOut {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface GraphResult {
  nodes: GraphNodeOut[];
  edges: GraphEdgeOut[];
  clusters: GraphCluster[];
  focus: string | null;
  truncated: boolean;
  total_nodes: number;
}

/**
 * FR-12 / 7：首屏只取高关联节点与一跳边；簇划分交给 clusterGraph，
 * 前端用 G6 combo 渲染，簇可折叠、双击节点展开下一跳。
 */
export async function graphData(
  ctx: Ctx,
  userId: number,
  query: { focus?: string; depth?: number; limit?: number } = {},
): Promise<GraphResult> {
  const limit = Math.max(1, Math.min(Number(query.limit ?? 200), 300));
  let focusId: number | null = null;
  if (query.focus) {
    const key = normalize(query.focus);
    // 聚焦输入支持精确 / 别名 / 包含 / 模糊（trgm）四级命中
    // 相似度操作符 % 只有 pg_trgm 提供，SQLite 侧退化为子串匹配
    const aliasRank =
      ctx.sql.dialect === 'pg'
        ? ctx.sql.fragment`(aliases && ${ctx.sql.array([key], OID.text)})`
        : ctx.sql.fragment`(EXISTS (
            SELECT 1 FROM json_each(term.aliases) a WHERE lower(a.value) = ${key}
          ))`;
    const focusMatch =
      ctx.sql.dialect === 'pg'
        ? ctx.sql.fragment`(
            lower(name) = ${key}
            OR aliases && ${ctx.sql.array([key], OID.text)}
            OR position(lower(name) in ${key}) > 0
            OR position(${key} in lower(name)) > 0
            OR lower(name) % ${key}
          )`
        : ctx.sql.fragment`(
            lower(name) = ${key}
            OR EXISTS (SELECT 1 FROM json_each(term.aliases) a WHERE lower(a.value) = ${key})
            OR instr(${key}, lower(name)) > 0
            OR instr(lower(name), ${key}) > 0
          )`;
    const rows = await ctx.sql<Array<{ id: number }>>`
      SELECT id FROM term
      WHERE user_id = ${userId} AND deleted_at IS NULL AND ${focusMatch}
      ORDER BY (lower(name) = ${key}) DESC, ${aliasRank} DESC, heat DESC, df DESC
      LIMIT 1`;
    if (!rows[0]) throw new AppError('E_TARGET_NOT_FOUND', `词 ${query.focus} 不存在`);
    focusId = Number(rows[0].id);
  }

  const nodeRows: Array<{ id: number; name: string; kind: string; df: number; heat: number; heat_at: Date }> =
    focusId !== null
      ? await ctx.sql`
          SELECT t.id, t.name, t.kind, t.df, t.heat, t.heat_at FROM term t
          WHERE t.id = ${focusId}
          UNION
          SELECT t2.id, t2.name, t2.kind, t2.df, t2.heat, t2.heat_at
          FROM term_edge e
          JOIN term t2 ON t2.id = CASE WHEN e.src_id = ${focusId} THEN e.dst_id ELSE e.src_id END
          WHERE (e.src_id = ${focusId} OR e.dst_id = ${focusId}) AND t2.deleted_at IS NULL
          LIMIT ${limit}`
      : await ctx.sql`
          SELECT id, name, kind, df, heat, heat_at FROM term
          WHERE user_id = ${userId} AND deleted_at IS NULL
          ORDER BY heat DESC, df DESC
          LIMIT ${limit}`;

  const totalRows = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM term WHERE user_id = ${userId} AND deleted_at IS NULL`;

  const ids = nodeRows.map((n) => Number(n.id));
  const edgeRows =
    ids.length > 1
      ? await ctx.sql<Array<{ src_id: number; dst_id: number; type: string; weight: number }>>`
          SELECT src_id, dst_id, type, weight FROM term_edge
          WHERE src_id IN (${ids}) AND dst_id IN (${ids})
          ORDER BY weight DESC
          LIMIT 2000`
      : [];

  const nodesInput = nodeRows.map((n) => ({
    id: Number(n.id),
    name: n.name,
    kind: n.kind,
    heat: heatNow(ctx, n, ctx.cfg.life.termHalfLifeDays),
  }));
  const edgesInput = edgeRows.map((e) => ({ src: Number(e.src_id), dst: Number(e.dst_id) }));
  const { assignments, clusters } = clusterGraph(nodesInput, edgesInput, { maxClusterSize: 30 });

  const degree = new Map<number, number>();
  for (const edge of edgeRows) {
    const s = Number(edge.src_id);
    const d = Number(edge.dst_id);
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(d, (degree.get(d) ?? 0) + 1);
  }

  const nodeById = new Map(nodesInput.map((n) => [n.id, n]));
  const nodes: GraphNodeOut[] = nodeRows.map((row) => {
    const id = Number(row.id);
    const input = nodeById.get(id);
    return {
      id: `t:${id}`,
      label: row.name,
      kind: row.kind,
      df: Number(row.df),
      heat: round(input?.heat ?? Number(row.heat)),
      degree: degree.get(id) ?? 0,
      cluster: assignments.get(id) ?? 'cl:0',
    };
  });
  const edges: GraphEdgeOut[] = edgeRows.map((e) => ({
    id: `${e.src_id}-${e.dst_id}-${e.type}`,
    source: `t:${e.src_id}`,
    target: `t:${e.dst_id}`,
    type: e.type,
    weight: round(Number(e.weight)),
  }));

  return {
    nodes,
    edges,
    clusters,
    focus: focusId !== null ? `t:${focusId}` : null,
    truncated: Number(totalRows[0]?.n ?? 0) > nodeRows.length,
    total_nodes: Number(totalRows[0]?.n ?? 0),
  };
}

/* ------------------------------------------------------------------ candidates */

export interface CandidateRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  evidence: number[];
  score: number;
  status: string;
  created_at: Date;
  reviewed_at: Date | null;
}

export async function listCandidates(
  ctx: Ctx,
  userId: number,
  status = 'pending',
): Promise<CandidateRow[]> {
  const rows = await ctx.sql<CandidateRow[]>`
    SELECT id, kind, payload, evidence, score, status, created_at, reviewed_at
    FROM promotion_candidate
    WHERE user_id = ${userId} AND (${status === 'all'} OR status = ${status})
    ORDER BY score DESC, created_at DESC
    LIMIT 100`;
  return rows.map((r) => ({ ...r, id: Number(r.id), evidence: (r.evidence ?? []).map(Number) }));
}

/** FR-09 人工候选路径：确认后写入 L1，仍需带来源指针且可撤销。 */
export async function approveCandidate(
  ctx: Ctx,
  userId: number,
  id: number,
  actor: Actor = 'human',
): Promise<{ block_id: number | null }> {
  const rows = await ctx.sql<CandidateRow[]>`
    SELECT id, kind, payload, evidence, score, status FROM promotion_candidate
    WHERE id = ${id} AND user_id = ${userId}`;
  const candidate = rows[0];
  if (!candidate) throw new AppError('E_TARGET_NOT_FOUND', `候选 ${id} 不存在`);
  if (candidate.status !== 'pending') throw new AppError('E_CONFLICT', '该候选已处理');

  let blockId: number | null = null;

  if (candidate.kind === 'skill') {
    const payload = candidate.payload as {
      content?: string;
      term_id?: number;
      term_name?: string;
      intent?: string;
      card_ids?: number[];
    };
    const summary =
      payload.content && [...payload.content].length <= ctx.cfg.life.skillMaxChars
        ? payload.content
        : buildSkillEntry(payload.term_name ?? '经验', payload.intent, ctx.cfg.life.skillMaxChars);
    const content = payload.content ?? summary;
    if ([...content].length > ctx.cfg.life.skillDetailMaxChars) {
      throw new AppError(
        'E_BLOCK_LIMIT',
        `固化条目详细描述超过 ${ctx.cfg.life.skillDetailMaxChars} 字`,
      );
    }
    const slot = `skill:${payload.term_id ?? id}`;
    const cardIds = (payload.card_ids ?? candidate.evidence ?? []).map(Number);
    const upserted = await ctx.sql<Array<{ id: number }>>`
      INSERT INTO mem_block (user_id, label, slot, summary, content, char_limit, source, heat, heat_at, last_used_at, ref_terms, ref_cards)
      VALUES (
        ${userId}, 'skills', ${slot}, ${summary}, ${content}, ${ctx.cfg.life.skillDetailMaxChars}, 'promoted',
        ${candidate.score}, ${ctx.now()}, ${ctx.now()},
        ${ctx.sql.array(payload.term_id ? [payload.term_id] : [], OID.int8)},
        ${ctx.sql.array(cardIds, OID.int8)}
      )
      ON CONFLICT (user_id, label, slot) WHERE deleted_at IS NULL
      DO UPDATE SET summary = EXCLUDED.summary, content = EXCLUDED.content,
                    heat = EXCLUDED.heat, heat_at = ${ctx.now()},
                    last_used_at = ${ctx.now()}, ref_terms = EXCLUDED.ref_terms,
                    ref_cards = EXCLUDED.ref_cards, version = mem_block.version + 1, updated_at = ${ctx.now()}
      RETURNING id`;
    blockId = Number(upserted[0]?.id ?? 0) || null;
    await writeAudit(ctx, {
      userId,
      objectType: 'block',
      objectId: blockId ?? id,
      op: 'promote.manual',
      before: { candidate_id: id },
      after: { content, slot, card_ids: cardIds },
      actor,
      reason: '人工批准晋升',
    });
  } else if (candidate.kind === 'block') {
    const payload = candidate.payload as {
      label?: string;
      slot?: string;
      summary?: string | null;
      content?: string;
      char_limit?: number;
    };
    const label = payload.label ?? '';
    const slot = payload.slot ?? 'default';
    if (!['persona', 'rules', 'skills'].includes(label)) {
      throw new AppError('E_INVALID', `块 ${label} 不合法`);
    }
    const content = payload.content;
    if (typeof content !== 'string') throw new AppError('E_INVALID', '候选缺少 content');
    const isSkillBlock = label === 'skills';
    const isTermSkill = /^skill:\d+$/.test(slot);
    const limitRows = await ctx.sql<Array<{ char_limit: number }>>`
      SELECT char_limit FROM mem_block
      WHERE user_id = ${userId} AND label = ${label} ORDER BY id LIMIT 1`;
    // skills 的 default 槽是容器（4000）；term 级条目 content 是详细描述，summary 另限 60 字
    const limit = isTermSkill
      ? ctx.cfg.life.skillDetailMaxChars
      : Number(limitRows[0]?.char_limit ?? payload.char_limit ?? (isSkillBlock ? 4000 : 2000));
    if ([...content].length > limit) {
      throw new AppError('E_BLOCK_LIMIT', `块 ${label} 超出字符上限 ${limit}`, {
        field: 'content',
        limit,
        actual: [...content].length,
      });
    }
    const summary = isSkillBlock
      ? (payload.summary ?? [...content].slice(0, ctx.cfg.life.skillMaxChars).join(''))
      : null;
    if (summary !== null && [...summary].length > ctx.cfg.life.skillMaxChars) {
      throw new AppError('E_BLOCK_LIMIT', `技能一句话描述超过 ${ctx.cfg.life.skillMaxChars} 字`, {
        field: 'summary',
        limit: ctx.cfg.life.skillMaxChars,
        actual: [...summary].length,
      });
    }
    const refTermIds = isTermSkill ? [Number(slot.split(':')[1])] : [];
    const upserted = await ctx.sql<Array<{ id: number; version: number }>>`
      INSERT INTO mem_block (
        user_id, label, slot, summary, content, char_limit, read_only, source,
        heat, heat_at, last_used_at, ref_terms
      )
      VALUES (${userId}, ${label}, ${slot}, ${summary}, ${content}, ${limit}, ${label === 'rules'}, 'agent',
              1.0, ${ctx.now()}, ${ctx.now()}, ${ctx.sql.array(refTermIds, OID.int8)})
      ON CONFLICT (user_id, label, slot) WHERE deleted_at IS NULL
      DO UPDATE SET summary = EXCLUDED.summary, content = EXCLUDED.content, source = 'agent',
                    version = mem_block.version + 1, updated_at = ${ctx.now()}
      RETURNING id, version`;
    blockId = Number(upserted[0]?.id ?? 0) || null;
    await writeAudit(ctx, {
      userId,
      objectType: 'block',
      objectId: blockId ?? id,
      op: 'promote.manual',
      before: { candidate_id: id, label, slot },
      after: { label, slot, summary, content },
      actor,
      reason: '人工批准常驻块变更',
    });
    await saveVersion(ctx, {
      objectType: 'block',
      objectId: blockId ?? id,
      version: Number(upserted[0]?.version ?? 1),
      snapshot: { summary, content },
      actor,
    });
  } else if (candidate.kind === 'merge') {
    const payload = candidate.payload as { source_id?: number; target_id?: number };
    if (!payload.source_id || !payload.target_id) {
      throw new AppError('E_INVALID', '合并候选缺少 source_id / target_id');
    }
    await mergeTerms(ctx, userId, Number(payload.source_id), Number(payload.target_id), actor);
  } else {
    throw new AppError('E_INVALID', `首版不支持自动批准 ${candidate.kind} 类型候选`);
  }

  await ctx.sql`
    UPDATE promotion_candidate SET status = 'approved', reviewed_at = ${ctx.now()} WHERE id = ${id}`;
  return { block_id: blockId };
}

export async function rejectCandidate(
  ctx: Ctx,
  userId: number,
  id: number,
  reason?: string,
  actor: Actor = 'human',
): Promise<void> {
  const rows = await ctx.sql<Array<{ status: string }>>`
    UPDATE promotion_candidate SET status = 'rejected', reviewed_at = ${ctx.now()}
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING status`;
  if (!rows[0]) throw new AppError('E_TARGET_NOT_FOUND', `候选 ${id} 不存在`);
  await writeAudit(ctx, {
    userId,
    objectType: 'candidate',
    objectId: id,
    op: 'reject',
    actor,
    reason,
  });
}

/* ------------------------------------------------------------------ audit */

export async function listAudit(
  ctx: Ctx,
  userId: number,
  query: { objectType?: string; objectId?: number; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const objectType = (query.objectType ?? '').trim();
  const objectId = query.objectId ?? null;
  const limit = Math.max(1, Math.min(Number(query.limit ?? 100), 500));
  const rows = await ctx.sql<Array<Record<string, unknown>>>`
    SELECT id, object_type, object_id, op, actor, reason, before, after, created_at
    FROM mem_audit
    WHERE user_id = ${userId}
      AND (${objectType === ''} OR object_type = ${objectType})
      AND (${objectId === null} OR object_id = ${objectId})
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows;
}

export async function listVersions(
  ctx: Ctx,
  objectType: string,
  objectId: number,
): Promise<Array<{ version: number; snapshot: unknown; actor: string; created_at: Date }>> {
  return ctx.sql`
    SELECT version, snapshot, actor, created_at FROM mem_version
    WHERE object_type = ${objectType} AND object_id = ${objectId}
    ORDER BY version DESC LIMIT 50`;
}

/* ------------------------------------------------------------------ blocks */

export async function listBlockDetails(ctx: Ctx, userId: number): Promise<Array<Record<string, unknown>>> {
  const rows = await ctx.sql<Array<Record<string, unknown>>>`
    SELECT id, label, slot, summary, content, use_count, char_limit, read_only, source, heat, version,
           ref_terms, ref_cards, updated_at
    FROM mem_block WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY CASE label
               WHEN 'persona' THEN 0 WHEN 'rules' THEN 1 WHEN 'skills' THEN 2 ELSE 3
             END,
             slot`;
  return rows.map((r) => ({
    ...r,
    id: Number(r.id),
    heat: round(Number(r.heat)),
    tokens: estimateTokens(String(r.content ?? '')),
  }));
}

export async function termSuggestions(
  ctx: Ctx,
  userId: number,
  q: string,
): Promise<Array<{ id: number; name: string; kind: string; df: number }>> {
  const key = normalize(q);
  if (!key) return [];
  const match =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`(position(lower(name) in ${key}) > 0
          OR aliases && ${ctx.sql.array([key], OID.text)})`
      : ctx.sql.fragment`(instr(${key}, lower(name)) > 0
          OR EXISTS (SELECT 1 FROM json_each(term.aliases) a WHERE lower(a.value) = ${key}))`;
  const rows = await ctx.sql<Array<{ id: number; name: string; kind: string; df: number }>>`
    SELECT id, name, kind, df FROM term
    WHERE user_id = ${userId} AND deleted_at IS NULL AND ${match}
    ORDER BY df DESC LIMIT 10`;
  return rows.map((r) => ({ ...r, id: Number(r.id), df: Number(r.df) }));
}

export function summarizeText(text: string, max = 80): string {
  return clampText(text.replace(/\s+/g, ' ').trim(), max);
}

export function uniqueStrings(values: unknown[]): string[] {
  return uniq(values.filter((v): v is string => typeof v === 'string'));
}

export function ageInDays(value: Date, now: Date): number {
  return Math.round(daysBetween(new Date(value), now));
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
