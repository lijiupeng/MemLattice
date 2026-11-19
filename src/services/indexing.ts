import { ALIAS_LINK } from '../core/alias.js';
import { normalize } from '../core/text.js';
import { OID, touchTermHeat, type Ctx } from './context.js';

export type TermKind = 'entity' | 'intent' | 'concept';
export type TermRole = 'subject' | 'intent' | 'keyword' | 'entity';

export interface TermInput {
  name: string;
  kind: TermKind;
  role: TermRole;
}

const ROLE_PRIORITY: Record<TermRole, number> = {
  subject: 4,
  intent: 3,
  entity: 2,
  keyword: 1,
};
const KIND_PRIORITY: Record<TermKind, number> = { entity: 3, intent: 2, concept: 1 };

interface TermRow {
  id: number;
  name: string;
  kind: TermKind;
  aliases: string[];
}

export interface ResolvedTerm {
  id: number;
  name: string;
  kind: TermKind;
  role: TermRole;
}

/**
 * FR-05：term 支持新增、合并、别名维护。写入前先按"名称 + 别名"归一，
 * 同义词（股票 / 股市 / A股 / 个股）落到同一节点。
 */
export async function upsertTerms(
  ctx: Ctx,
  userId: number,
  inputs: readonly TermInput[],
): Promise<Map<string, ResolvedTerm>> {
  const merged = new Map<string, { name: string; kind: TermKind; role: TermRole }>();
  for (const input of inputs) {
    const key = normalize(input.name);
    if (!key || key.length > 60) continue;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { name: key, kind: input.kind, role: input.role });
      continue;
    }
    merged.set(key, {
      name: prev.name,
      kind: KIND_PRIORITY[input.kind] > KIND_PRIORITY[prev.kind] ? input.kind : prev.kind,
      role: ROLE_PRIORITY[input.role] > ROLE_PRIORITY[prev.role] ? input.role : prev.role,
    });
  }
  if (merged.size === 0) return new Map();

  const names = [...merged.keys()];
  // PG 的数组重叠操作符在 SQLite 没有对应物，用 json_each 展开别名后判断
  const aliasHit =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`aliases && ${ctx.sql.array(names, OID.text)}`
      : ctx.sql.fragment`EXISTS (
          SELECT 1 FROM json_each(term.aliases) AS a WHERE a.value IN (${names})
        )`;
  const existing = await ctx.sql<TermRow[]>`
    SELECT id, name, kind, aliases FROM term
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND (lower(name) IN (${names}) OR ${aliasHit})`;

  const byName = new Map<string, TermRow>();
  for (const row of existing) {
    byName.set(normalize(row.name), row);
    for (const alias of row.aliases ?? []) byName.set(normalize(alias), row);
  }

  const resolved = new Map<string, ResolvedTerm>();
  for (const [key, info] of merged) {
    let row = byName.get(key);
    if (!row) {
      const inserted = await ctx.sql<TermRow[]>`
        INSERT INTO term (user_id, name, kind)
        VALUES (${userId}, ${info.name}, ${info.kind})
        ON CONFLICT DO NOTHING
        RETURNING id, name, kind, aliases`;
      row = inserted[0];
      if (!row) {
        const again = await ctx.sql<TermRow[]>`
          SELECT id, name, kind, aliases FROM term
          WHERE user_id = ${userId} AND lower(name) = ${key} AND deleted_at IS NULL
          LIMIT 1`;
        row = again[0];
      }
      if (!row) continue;
      byName.set(key, row);
    } else if (KIND_PRIORITY[info.kind] > KIND_PRIORITY[row.kind]) {
      await ctx.sql`UPDATE term SET kind = ${info.kind} WHERE id = ${row.id}`;
      row = { ...row, kind: info.kind };
    }
    resolved.set(key, { id: Number(row.id), name: row.name, kind: row.kind, role: info.role });
  }
  return resolved;
}

export interface IndexCardInput {
  userId: number;
  cardId: number;
  intent: string | null;
  keywords: readonly string[];
  entities: readonly string[];
  rawIds: readonly number[];
  /** 重新索引时不重复累计"被新卡引用"热度 */
  applyHeat?: boolean;
}

/**
 * 5.1 写入路径第 3–5 步：切词 → upsert term → 写 card_term → 共现边 → 更新 df。
 */
export async function indexCard(ctx: Ctx, input: IndexCardInput): Promise<number[]> {
  const inputs: TermInput[] = [];
  if (input.intent) inputs.push({ name: input.intent, kind: 'intent', role: 'intent' });
  for (const entity of input.entities) {
    inputs.push({ name: entity, kind: 'entity', role: 'entity' });
  }
  for (const keyword of input.keywords) {
    inputs.push({ name: keyword, kind: 'concept', role: 'keyword' });
  }
  // 实体同时作为关键词时，按更高优先级归一
  for (const entity of input.entities) {
    inputs.push({ name: entity, kind: 'entity', role: 'keyword' });
  }

  const resolved = await upsertTerms(ctx, input.userId, inputs);
  if (resolved.size === 0) {
    await linkRaws(ctx, input.cardId, input.rawIds);
    return [];
  }

  const byTermId = new Map<number, ResolvedTerm>();
  for (const term of resolved.values()) {
    const prev = byTermId.get(term.id);
    if (!prev || ROLE_PRIORITY[term.role] > ROLE_PRIORITY[prev.role]) byTermId.set(term.id, term);
  }
  const terms = [...byTermId.values()];
  const termIds = terms.map((t) => t.id);

  await ctx.sql`DELETE FROM card_term WHERE card_id = ${input.cardId}`;

  const cardTermRows = terms.map((t) => [
    input.cardId,
    t.id,
    t.role,
    t.role === 'intent' ? 2.0 : t.role === 'entity' ? 1.5 : 1.0,
  ]);
  if (cardTermRows.length > 0) {
    await ctx.sql`
      INSERT INTO card_term (card_id, term_id, role, weight)
      VALUES ${ctx.sql.values(cardTermRows)}
      ON CONFLICT (card_id, term_id, role)
      DO UPDATE SET weight = CASE
        WHEN card_term.weight >= EXCLUDED.weight THEN card_term.weight
        ELSE EXCLUDED.weight END`;
  }

  await upsertCoOccurrence(ctx, termIds.slice(0, 12));
  await refreshDocumentFrequency(ctx, termIds);
  await upsertAliasEdges(ctx, termIds);
  if (input.applyHeat !== false) {
    await touchTermHeat(ctx, termIds, 2.0, false);
  }
  await linkRaws(ctx, input.cardId, input.rawIds);
  return termIds;
}

async function linkRaws(ctx: Ctx, cardId: number, rawIds: readonly number[]): Promise<void> {
  if (rawIds.length === 0) return;
  await ctx.sql`
    INSERT INTO card_raw (card_id, raw_id)
    VALUES ${ctx.sql.values(rawIds.map((rawId): unknown[] => [cardId, rawId]))}
    ON CONFLICT DO NOTHING`;
}

/** 同卡内词两两计共现（双向边，权重各 0.5，避免单向图导致扩散不对称）。 */
async function upsertCoOccurrence(ctx: Ctx, termIds: readonly number[]): Promise<void> {
  if (termIds.length < 2) return;
  const srcs: number[] = [];
  const dsts: number[] = [];
  for (let i = 0; i < termIds.length; i++) {
    for (let j = i + 1; j < termIds.length; j++) {
      const a = termIds[i] as number;
      const b = termIds[j] as number;
      if (a === b) continue;
      srcs.push(a, b);
      dsts.push(b, a);
    }
  }
  if (srcs.length === 0) return;
  const edgeRows = srcs.map((src, index) => [src, dsts[index], 'co_occur', 0.5]);
  await ctx.sql`
    INSERT INTO term_edge (src_id, dst_id, type, weight)
    VALUES ${ctx.sql.values(edgeRows)}
    ON CONFLICT (src_id, dst_id, type)
    DO UPDATE SET weight = term_edge.weight + EXCLUDED.weight, updated_at = ${ctx.now()}`;
}

/**
 * 同义边：某词的 aliases 命中另一个词的 name（或反向）时，双向写 alias 边。
 * 边权只取 GREATEST，不累加——同义关系不该因为反复写入而变得比共现更强。
 */
export async function upsertAliasEdges(ctx: Ctx, termIds: readonly number[]): Promise<number> {
  if (termIds.length === 0) return 0;
  // 「别名命中另一个词的名字」在两端写法不同：PG 用数组操作符，SQLite 展开 JSON 数组
  const match =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`(lower(o.name) = ANY(t.aliases) OR o.aliases && ARRAY[lower(t.name)]::text[])`
      : ctx.sql.fragment`(
          EXISTS (SELECT 1 FROM json_each(t.aliases) AS ta WHERE lower(ta.value) = lower(o.name))
          OR EXISTS (SELECT 1 FROM json_each(o.aliases) AS oa WHERE lower(oa.value) = lower(t.name))
        )`;
  const pairs = await ctx.sql<Array<{ a: number; b: number }>>`
    SELECT DISTINCT t.id AS a, o.id AS b
    FROM term t
    JOIN term o ON o.user_id = t.user_id AND o.deleted_at IS NULL AND o.id <> t.id
    WHERE t.id IN (${[...termIds]})
      AND t.deleted_at IS NULL
      AND ${match}`;
  if (pairs.length === 0) return 0;

  const edges: unknown[][] = [];
  for (const pair of pairs) {
    edges.push([pair.a, pair.b, 'alias', ALIAS_LINK.edgeWeight]);
    edges.push([pair.b, pair.a, 'alias', ALIAS_LINK.edgeWeight]);
  }
  await ctx.sql`
    INSERT INTO term_edge (src_id, dst_id, type, weight)
    VALUES ${ctx.sql.values(edges)}
    ON CONFLICT (src_id, dst_id, type)
    DO UPDATE SET weight = CASE
        WHEN term_edge.weight >= EXCLUDED.weight THEN term_edge.weight
        ELSE EXCLUDED.weight END,
      updated_at = ${ctx.now()}`;
  return edges.length;
}

async function refreshDocumentFrequency(ctx: Ctx, termIds: readonly number[]): Promise<void> {
  if (termIds.length === 0) return;
  await ctx.sql`
    UPDATE term
    SET df = sub.c
    FROM (
      SELECT term_id, count(DISTINCT card_id) AS c
      FROM card_term
      WHERE term_id IN (${[...termIds]})
      GROUP BY term_id
    ) sub
    WHERE term.id = sub.term_id`;
}

/**
 * FR-05：别名合并时把两个节点的 card_term 合并到同一节点。
 * 合并后 source 被软删、只剩一个节点，所以这里不写 source↔target 的 alias 边；
 * 保留两个独立节点、只声明同义关系的情况，才由 upsertAliasEdges 建边。
 */
export async function mergeTermInto(
  ctx: Ctx,
  sourceId: number,
  targetId: number,
): Promise<{ movedCards: number }> {
  if (sourceId === targetId) return { movedCards: 0 };
  // 拆成「先读后写」：数据修改型 CTE（WITH … INSERT … RETURNING）只有 PG 支持
  const sourceCardTerms = await ctx.sql<Array<{ card_id: number; role: string; weight: number }>>`
    SELECT card_id, role, weight FROM card_term WHERE term_id = ${sourceId}`;
  if (sourceCardTerms.length > 0) {
    await ctx.sql`
      INSERT INTO card_term (card_id, term_id, role, weight)
      VALUES ${ctx.sql.values(
        sourceCardTerms.map((row): unknown[] => [row.card_id, targetId, row.role, row.weight]),
      )}
      ON CONFLICT (card_id, term_id, role)
      DO UPDATE SET weight = CASE
        WHEN card_term.weight >= EXCLUDED.weight THEN card_term.weight
        ELSE EXCLUDED.weight END`;
  }
  const movedCards = new Set(sourceCardTerms.map((row) => row.card_id)).size;
  await ctx.sql`DELETE FROM card_term WHERE term_id = ${sourceId}`;

  const srcRows = await ctx.sql<{ name: string; aliases: string[] }[]>`
    SELECT name, aliases FROM term WHERE id = ${sourceId}`;
  const src = srcRows[0];
  if (src) {
    const aliasSet = new Set([src.name, ...(src.aliases ?? [])].map(normalize));
    const targetRows = await ctx.sql<{ aliases: string[] }[]>`
      SELECT aliases FROM term WHERE id = ${targetId}`;
    const targetAliases = new Set((targetRows[0]?.aliases ?? []).map(normalize));
    for (const alias of aliasSet) targetAliases.add(alias);
    await ctx.sql`
      UPDATE term SET aliases = ${ctx.sql.array([...targetAliases], OID.text)} WHERE id = ${targetId}`;
  }

  // 边重定向：把 source 的出边/入边挂到 target，再删除 source（级联清理剩余边）
  await ctx.sql`
    INSERT INTO term_edge (src_id, dst_id, type, weight)
    SELECT ${targetId}, dst_id, type, weight
    FROM term_edge WHERE src_id = ${sourceId} AND dst_id <> ${targetId}
    ON CONFLICT (src_id, dst_id, type)
    DO UPDATE SET weight = term_edge.weight + EXCLUDED.weight, updated_at = ${ctx.now()}`;
  await ctx.sql`
    INSERT INTO term_edge (src_id, dst_id, type, weight)
    SELECT src_id, ${targetId}, type, weight
    FROM term_edge WHERE dst_id = ${sourceId} AND src_id <> ${targetId}
    ON CONFLICT (src_id, dst_id, type)
    DO UPDATE SET weight = term_edge.weight + EXCLUDED.weight, updated_at = ${ctx.now()}`;
  await ctx.sql`DELETE FROM term_edge WHERE src_id = ${sourceId} OR dst_id = ${sourceId}`;
  await ctx.sql`
    UPDATE term SET deleted_at = ${ctx.now()}, aliases = ${ctx.sql.array([], OID.text)}
    WHERE id = ${sourceId}`;

  await refreshDocumentFrequency(ctx, [targetId]);
  // target 的 aliases 现在包含 source 的 name，可能对上别的节点
  await upsertAliasEdges(ctx, [targetId]);
  return { movedCards };
}
