import { clampText } from '../core/text.js';
import { heatNow, OID, type Ctx } from './context.js';

export type GraphNodeType = 'l1' | 'card' | 'term' | 'raw';
export type GraphEdgeType = 'holds' | 'mentions' | 'co_occur' | 'evidence';

export interface LayeredNode {
  id: string;
  type: GraphNodeType;
  /** 0=L1 根，1=关键词，2=事件卡（径向图按层着色） */
  layer: 0 | 1 | 2 | 3;
  label: string;
  sublabel?: string;
  heat: number;
  expandable: boolean;
  child_count: number;
  meta: Record<string, unknown>;
}

export interface LayeredEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  weight: number;
  label?: string;
}

export interface GraphStats {
  cards: number;
  terms: number;
  raws: number;
  blocks: number;
  skills: number;
  skeleton: number;
}

const LAYER_OF = { l1: 0, term: 1, card: 2, raw: 3 } as const;

/**
 * 径向全图：链路为 根节点 → 关键词 → 记忆卡片。
 * 关键词按「出现的记忆卡数 ≥ minCards」过滤，再按热度取前 heatTop（0 = 全部）；
 * 一张卡的命中词全被过滤掉时，该卡直连根节点，不丢卡。L3 原文不进图。
 * 节点是显示投影，不落库（原则 1：单一真相源）。
 */
export async function graphRadial(
  ctx: Ctx,
  userId: number,
  input: { minCards?: number; heatTop?: number } = {},
): Promise<{ nodes: LayeredNode[]; edges: LayeredEdge[]; stats: GraphStats }> {
  const minCards = Math.max(1, Math.min(Number(input.minCards ?? 3), 100));
  const heatTop = Math.max(0, Math.min(Number(input.heatTop ?? 0), 200));

  const statRows = await ctx.sql<
    Array<{ cards: number; terms: number; raws: number; blocks: number; skills: number; skeleton: number }>
  >`
    SELECT
      (SELECT count(*) FROM mem_card WHERE user_id = ${userId} AND deleted_at IS NULL AND status = 'ready') AS cards,
      (SELECT count(*) FROM term WHERE user_id = ${userId} AND deleted_at IS NULL) AS terms,
      (SELECT count(*) FROM mem_raw WHERE user_id = ${userId}) AS raws,
      (SELECT count(*) FROM mem_block WHERE user_id = ${userId} AND deleted_at IS NULL) AS blocks,
      (SELECT count(*) FROM mem_block
        WHERE user_id = ${userId} AND label = 'skills' AND slot LIKE 'skill:%' AND deleted_at IS NULL) AS skills,
      (SELECT count(*) FROM mem_card WHERE user_id = ${userId} AND deleted_at IS NULL AND is_skeleton = true) AS skeleton`;
  const stat = statRows[0] ?? { cards: 0, terms: 0, raws: 0, blocks: 0, skills: 0, skeleton: 0 };
  const stats: GraphStats = {
    cards: Number(stat.cards),
    terms: Number(stat.terms),
    raws: Number(stat.raws),
    blocks: Number(stat.blocks),
    skills: Number(stat.skills),
    skeleton: Number(stat.skeleton),
  };

  const root: LayeredNode = {
    id: 'l1:root',
    type: 'l1',
    layer: LAYER_OF.l1,
    label: 'L1 常驻记忆',
    sublabel: `${stats.skills} 条经验 · ${stats.blocks} 个块 · ${stats.cards} 张卡`,
    heat: 0,
    expandable: false,
    child_count: stats.cards,
    meta: { ...stats, minCards, heatTop },
  };

  const cardRows = await ctx.sql<
    Array<{
      id: number;
      summary: string;
      intent: string | null;
      heat: number;
      heat_at: Date;
      created_at: Date;
      is_skeleton: boolean;
      category: string;
      keywords: string[];
    }>
  >`
    SELECT id, summary, intent, heat, heat_at, created_at, is_skeleton, category, keywords
    FROM mem_card
    WHERE user_id = ${userId} AND deleted_at IS NULL AND status = 'ready'
    ORDER BY heat DESC, created_at DESC`;

  const cardIds = cardRows.map((row) => Number(row.id));
  const nodes: LayeredNode[] = [root];
  const edges: LayeredEdge[] = [];

  // 关键词：卡内出现次数 ≥ minCards，按热度排序，可选只取前 heatTop 个
  const termRows =
    cardIds.length > 0
      ? await ctx.sql<
          Array<{ id: number; name: string; kind: string; df: number; heat: number; heat_at: Date; card_count: number }>
        >`
          SELECT t.id, t.name, t.kind, t.df, t.heat, t.heat_at, count(DISTINCT ct.card_id) AS card_count
          FROM card_term ct
          JOIN term t ON t.id = ct.term_id
          WHERE ct.card_id IN (${cardIds}) AND t.deleted_at IS NULL
          GROUP BY t.id
          HAVING count(DISTINCT ct.card_id) >= ${minCards}
          ORDER BY t.heat DESC, t.df DESC, t.id`
      : [];
  const displayedTerms = heatTop > 0 ? termRows.slice(0, heatTop) : termRows;
  const displayedTermIds = new Set(displayedTerms.map((row) => Number(row.id)));

  for (const row of displayedTerms) {
    const termId = Number(row.id);
    nodes.push({
      id: `term:${termId}`,
      type: 'term',
      layer: LAYER_OF.term,
      label: row.name,
      sublabel: `${kindLabel(row.kind)} · ${row.card_count} 卡`,
      heat: round(heatNow(ctx, row, ctx.cfg.life.termHalfLifeDays)),
      expandable: false,
      child_count: Number(row.card_count),
      meta: { name: row.name, kind: row.kind, df: Number(row.df), card_count: Number(row.card_count) },
    });
    edges.push({
      id: `l1:root->term:${termId}`,
      source: 'l1:root',
      target: `term:${termId}`,
      type: 'holds',
      weight: Number(row.card_count),
      label: `${row.card_count} 卡`,
    });
  }

  // 命中卡：词 → 卡；一张卡若没有任何显示中的词命中，则直连根节点
  const linkedCards = new Set<number>();
  if (displayedTermIds.size > 0 && cardIds.length > 0) {
    const linkRows = await ctx.sql<
      Array<{ card_id: number; term_id: number; role: string; weight: number }>
    >`
      SELECT ct.card_id, ct.term_id, ct.role, ct.weight
      FROM card_term ct
      WHERE ct.term_id IN (${[...displayedTermIds]})
        AND ct.card_id IN (${cardIds})
      ORDER BY ct.weight DESC`;

    for (const row of linkRows) {
      const cardId = Number(row.card_id);
      const termId = Number(row.term_id);
      linkedCards.add(cardId);
      edges.push({
        id: `term:${termId}->card:${cardId}`,
        source: `term:${termId}`,
        target: `card:${cardId}`,
        type: 'mentions',
        weight: round(Number(row.weight)),
        label: row.role,
      });
    }
  }

  // 未命中任何显示词的卡统一挂到「其他」词节点：所有卡与根都相距两跳，确保都在最外环
  const orphanCards = cardRows.filter((row) => !linkedCards.has(Number(row.id)));
  if (orphanCards.length > 0) {
    nodes.push({
      id: 'term:0',
      type: 'term',
      layer: LAYER_OF.term,
      label: '其他',
      sublabel: `${orphanCards.length} 张未命中词卡`,
      heat: 0,
      expandable: false,
      child_count: orphanCards.length,
      meta: { name: '其他', kind: 'concept', df: 0, card_count: orphanCards.length, synthetic: true },
    });
    edges.push({
      id: 'l1:root->term:0',
      source: 'l1:root',
      target: 'term:0',
      type: 'holds',
      weight: orphanCards.length,
      label: `${orphanCards.length} 卡`,
    });
    for (const row of orphanCards) {
      edges.push({
        id: `term:0->card:${row.id}`,
        source: 'term:0',
        target: `card:${row.id}`,
        type: 'mentions',
        weight: 1,
        label: '未命中词',
      });
    }
  }

  for (const row of cardRows) {
    const cardId = Number(row.id);
    nodes.push({
      id: `card:${cardId}`,
      type: 'card',
      layer: LAYER_OF.card,
      label: clampText(row.summary.replace(/\s+/g, ' ').trim(), 22),
      sublabel: `${row.intent ?? '未标意图'} · ${row.keywords.length} 词${row.is_skeleton ? ' · 骨架' : ''}`,
      heat: round(heatNow(ctx, row, ctx.cfg.life.cardHalfLifeDays)),
      expandable: false,
      child_count: row.keywords.length,
      meta: {
        summary: row.summary,
        intent: row.intent,
        keywords: row.keywords,
        created_at: row.created_at,
        skeleton: row.is_skeleton,
        category: row.category,
        linked: linkedCards.has(cardId),
      },
    });
  }

  if (displayedTermIds.size > 1) {
    const coEdges = await ctx.sql<Array<{ src_id: number; dst_id: number; weight: number }>>`
      SELECT src_id, dst_id, weight FROM term_edge
      WHERE type = 'co_occur'
        AND src_id IN (${[...displayedTermIds]})
        AND dst_id IN (${[...displayedTermIds]})`;
    for (const edge of coEdges) {
      edges.push({
        id: `co:${edge.src_id}-${edge.dst_id}`,
        source: `term:${edge.src_id}`,
        target: `term:${edge.dst_id}`,
        type: 'co_occur',
        weight: round(Number(edge.weight)),
      });
    }
  }

  return { nodes, edges, stats };
}

function kindLabel(kind: string): string {
  if (kind === 'entity') return '实体';
  if (kind === 'intent') return '意图';
  return '概念';
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
