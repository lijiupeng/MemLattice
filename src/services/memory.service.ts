import { ALIAS_LINK, expandAliasSeeds } from '../core/alias.js';
import { AppError, isAppError } from '../core/errors.js';
import { daysBetween } from '../core/heat.js';
import { makePackItem, pack, type PackItem } from '../core/packer.js';
import { personalizedPageRank, type PprEdge } from '../core/ppr.js';
import { cardScore, isCold, isStrong, precisionFactor } from '../core/scoring.js';
import { clampText, hashContent, normalize, uniq } from '../core/text.js';
import { tokenizeKeywords } from '../core/tokenizer.js';
import { estimateTokens } from '../core/tokens.js';
import { composeCard, sanitizeKeywords, type CardOverrides, type CondenseMessage } from '../core/condense.js';
import { buildSkillIndex, skillCondition, type SkillIndexEntry } from '../core/skill.js';
import { mergeSummary, pickAppendTarget, type DedupeCandidate } from '../core/dedupe.js';
import { indexCard, upsertAliasEdges } from './indexing.js';
import { sleepPressure } from './maintenance.service.js';
import {
  getUserId,
  heatNow,
  OID,
  recordCardHit,
  saveVersion,
  touchBlockUsed,
  touchCardHeat,
  touchTermHeat,
  writeAudit,
  type Actor,
  type Ctx,
} from './context.js';

export const SCOPES = ['all', 'project', 'person'] as const;
export type Scope = (typeof SCOPES)[number];

interface BlockRow {
  id: number;
  label: string;
  slot: string;
  /** 技能的一句话描述；其它块为 null */
  summary: string | null;
  content: string;
  char_limit: number;
  read_only: boolean;
  source: string;
  heat: number;
  heat_at: Date;
  last_used_at: Date | null;
  ref_terms: number[];
  ref_cards: number[];
  version: number;
  /** 被 memory.expand 按 id 取用的次数 */
  use_count: number;
}

interface TermRow {
  id: number;
  name: string;
  kind: string;
  df: number;
  heat: number;
  heat_at: Date;
  last_hit_at: Date | null;
  aliases: string[];
}

interface CardRow {
  id: number;
  event_id: number;
  version?: number;
  status?: string;
  summary: string;
  intent: string | null;
  keywords: string[];
  entities: string[];
  importance: number;
  heat: number;
  heat_at: Date;
  last_hit_at: Date | null;
  created_at: Date;
  is_skeleton: boolean;
  stale_at: Date | null;
  source: string;
  category: string;
  /** 被采用的次数：expand 读正文、append_to 引用、feedback=helpful */
  use_count?: number;
  /** 被召回的次数，只算曝光，不加热度 */
  hit_count?: number;
  confidence?: number;
  ppr_score?: number;
  overlap?: number;
}

/* ------------------------------------------------------------------ L1 */

export async function listBlocks(ctx: Ctx, userId: number): Promise<BlockRow[]> {
  const rows = await ctx.sql<BlockRow[]>`
    SELECT id, label, slot, summary, content, char_limit, read_only, source, heat, heat_at,
           last_used_at, ref_terms, ref_cards, version, use_count
    FROM mem_block
    WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY CASE label
               WHEN 'persona' THEN 0 WHEN 'rules' THEN 1 WHEN 'skills' THEN 2 ELSE 3
             END,
             heat DESC, id`;
  return rows;
}

const LABEL_TITLE: Record<string, string> = {
  rules: '【硬规则】',
  persona: '【性格与表达】',
  skills: '【经验】',
};

function buildL1Items(blocks: readonly BlockRow[]): {
  items: PackItem[];
  skills: SkillIndexEntry[];
} {
  const items: PackItem[] = [];
  const skills: SkillIndexEntry[] = [];
  for (const block of blocks) {
    const content = block.content.trim();
    if (!content) continue;
    if (block.label === 'skills') {
      // 经验（含通用 default 槽）只进索引：id + 一句话总结 + 调用次数；
      // 详细描述一律按 block_id 现取，不占 L1 预算
      skills.push({
        blockId: Number(block.id),
        summary: block.summary,
        useCount: Number(block.use_count ?? 0),
        content,
      });
      continue;
    }
    // 注入优先级：硬规则 > 性格（skills 在上面已走索引分支，不会到这里）
    const tier = block.label === 'rules' ? 0 : 1;
    items.push(
      makePackItem({
        key: `block:${block.label}:${block.slot}`,
        kind: 'block',
        tier,
        score: block.label === 'rules' ? 1 : 0.8,
        text: `${LABEL_TITLE[block.label] ?? `【${block.label}】`}\n${content}`,
        // 常驻块整块保留或整块丢弃，不做半句截断
        truncatable: false,
        meta: { block_id: Number(block.id), label: block.label, slot: block.slot, source: block.source },
      }),
    );
  }
  return { items, skills };
}

/* ------------------------------------------------------------------ seeds */

const LN2 = Math.log(2);

export interface SeedInfo {
  ids: number[];
  weights: Map<number, number>;
  matched: Array<{ id: number; name: string }>;
}

/**
 * FR-05：短语优先——先匹配现有 term 词典（名称 + 别名），未命中再交给分词器。
 * 全流程无模型参与，入口词完全由本地词典与切词决定。
 */
export async function extractSeeds(ctx: Ctx, userId: number, query: string): Promise<SeedInfo> {
  const q = normalize(query);
  let weights = new Map<number, number>();
  const matched: Array<{ id: number; name: string }> = [];
  if (!q) return { ids: [], weights, matched };

  const add = (id: number, name: string): void => {
    const key = Number(id);
    if (!weights.has(key)) weights.set(key, 1.0 + Math.min(0.5, [...name].length * 0.1));
    if (!matched.some((m) => m.id === key)) matched.push({ id: key, name });
  };

  // 子串包含：PG 用 position/unnest，SQLite 用 instr/json_each
  const nameHit =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`position(lower(name) in ${q}) > 0`
      : ctx.sql.fragment`instr(${q}, lower(name)) > 0`;
  const aliasHit =
    ctx.sql.dialect === 'pg'
      ? ctx.sql.fragment`EXISTS (
          SELECT 1 FROM unnest(aliases) AS a
          WHERE length(a) > 0 AND position(lower(a) in ${q}) > 0
        )`
      : ctx.sql.fragment`EXISTS (
          SELECT 1 FROM json_each(term.aliases) AS a
          WHERE length(a.value) > 0 AND instr(${q}, lower(a.value)) > 0
        )`;
  const dict = await ctx.sql<Array<{ id: number; name: string }>>`
    SELECT id, name FROM term
    WHERE user_id = ${userId} AND deleted_at IS NULL AND (${nameHit} OR ${aliasHit})
    ORDER BY length(name) DESC, df DESC
    LIMIT 12`;
  for (const row of dict) add(row.id, row.name);

  if (matched.length === 0) {
    const tokens = tokenizeKeywords(ctx.tokenizer, query).slice(0, 6);
    if (tokens.length > 0) {
      const tokenAliasHit =
        ctx.sql.dialect === 'pg'
          ? ctx.sql.fragment`aliases && ${ctx.sql.array(tokens, OID.text)}`
          : ctx.sql.fragment`EXISTS (
              SELECT 1 FROM json_each(term.aliases) AS a WHERE a.value IN (${tokens})
            )`;
      const rows = await ctx.sql<Array<{ id: number; name: string }>>`
        SELECT id, name FROM term
        WHERE user_id = ${userId} AND deleted_at IS NULL
          AND (lower(name) IN (${tokens}) OR ${tokenAliasHit})
        ORDER BY df DESC LIMIT 8`;
      for (const row of rows) add(row.id, row.name);
    }
  }

  // 同义扩展：命中的种子再沿 alias 边走出去一圈，权重打折后并入种子。
  // 只做一跳——两跳会把同义簇越铺越大，最终等价于把整张词表都当种子。
  if (matched.length > 0) {
    const aliasRows = await ctx.sql<Array<{ src_id: number; dst_id: number; name: string }>>`
      SELECT e.src_id, e.dst_id, t.name
      FROM term_edge e
      JOIN term t ON t.id = e.dst_id
      WHERE e.type = 'alias'
        AND e.src_id IN (${matched.map((m) => m.id)})
        AND t.user_id = ${userId} AND t.deleted_at IS NULL
      ORDER BY e.weight DESC, t.df DESC`;
    const expanded = expandAliasSeeds(
      weights,
      aliasRows.map((row) => ({
        srcId: Number(row.src_id),
        dstId: Number(row.dst_id),
        name: row.name,
      })),
    );
    for (const item of expanded.added) matched.push(item);
    weights = expanded.weights;
  }

  return { ids: matched.map((m) => m.id), weights, matched };
}

async function buildSubgraph(
  ctx: Ctx,
  seedIds: readonly number[],
): Promise<{ nodes: number[]; edges: PprEdge[] }> {
  if (seedIds.length === 0) return { nodes: [], edges: [] };
  // 两跳扩散放在 JS 里跑：递归 CTE 的种子展开依赖数组类型，SQLite 没有对应写法
  const seen = new Set<number>(seedIds.map(Number));
  let frontier = [...seen];
  for (let depth = 0; depth < 2 && frontier.length > 0 && seen.size < 5000; depth += 1) {
    const rows = await ctx.sql<Array<{ dst_id: number }>>`
      SELECT DISTINCT dst_id FROM term_edge WHERE src_id IN (${frontier})`;
    const next: number[] = [];
    for (const row of rows) {
      const id = Number(row.dst_id);
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(id);
      if (seen.size >= 5000) break;
    }
    frontier = next;
  }
  const nodes = [...seen];
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const edgeRows = await ctx.sql<
    Array<{ src_id: number; dst_id: number; type: string; weight: number }>
  >`
    SELECT src_id, dst_id, type, weight FROM term_edge
    WHERE src_id IN (${nodes}) AND dst_id IN (${nodes})`;
  return {
    nodes,
    // 同义边再降一档：它只说明"说法不同"，不代表两件事真的常一起出现
    edges: edgeRows.map((e) => ({
      src: Number(e.src_id),
      dst: Number(e.dst_id),
      weight: Number(e.weight) * (e.type === 'alias' ? ALIAS_LINK.edgeFactor : 1),
    })),
  };
}

/* ------------------------------------------------------------------ recall */

export interface RecallInput {
  query: string;
  scope?: Scope;
  budgetTokens?: number;
  includeWeak?: boolean;
  actor?: Actor;
  /** 返回 trace / injection_order / dropped 明细，仅排查时开启 */
  debug?: boolean;
}

export interface RecallBlockOut {
  label: string;
  slot?: string;
  text: string;
  tokens: number;
  source?: string;
  block_id?: number;
  ref_terms?: number[];
  ref_cards?: number[];
}

export interface RecallCardOut {
  id: number;
  event_id: number;
  summary: string;
  intent: string | null;
  keywords: string[];
  entities: string[];
  importance: number;
  heat: number;
  score: number;
  tokens: number;
  stale: boolean;
  skeleton: boolean;
  /** user | external | system：external 表示内容来自外部，需核实后再当事实 */
  source: string;
  /** 0–1：被 memory.feedback 判错会下调，低于 0.3 视为存疑 */
  confidence: number;
}

export interface RecallHint {
  card_id: number;
  text: string;
  summary: string;
}

export interface RecallDropped {
  key: string;
  kind: string;
  tokens: number;
  /**
   * budget：预算装不下；truncated-to-zero：可截断但找不到句末边界；
   * cold：冷数据不注入；weak_trimmed：弱关联超出 weakHintLimit；
   * df_filtered：df<2 不参与扩散；limit_truncated：候选/入选条数被上限截断。
   */
  reason: string;
  /** 仅聚合项（terms:*）使用：该原因下未逐条列出的数量 */
  count?: number;
}

export interface RecallResult {
  query: string;
  scope: Scope;
  budget_limit: number;
  budget_used: number;
  blocks: RecallBlockOut[];
  recent_index: Array<{ event_id: number; keywords: string[] }>;
  cards: RecallCardOut[];
  hints: RecallHint[];
  dropped: RecallDropped[];
  dropped_count: number;
  /** 本轮注入快照 id；写快照失败时省略（不影响召回结果） */
  recall_id?: number;
  /** 有内容因预算被丢弃或截断 */
  truncated: boolean;
  stale_refresh_queued: number;
  /** 仅在 debug=true 时返回 */
  trace?: {
    seeds: Array<{ id: number; name: string }>;
    terms: Array<{ id: number; name: string; ppr: number }>;
    candidates: number;
    elapsed_ms: number;
  };
  injection_order?: string[];
  /** 仅在需要提示用户时返回（空召回、骨架卡等） */
  note?: string;
}

export async function recall(ctx: Ctx, input: RecallInput): Promise<RecallResult> {
  const started = Date.now();
  const cfg = ctx.cfg;
  const requested = input.budgetTokens ?? cfg.budget.defaultTokens;
  if (requested > cfg.budget.maxTokens) {
    throw new AppError('E_BUDGET_EXCEEDED', `预算 ${requested} 超过系统上限 ${cfg.budget.maxTokens}`, {
      max: cfg.budget.maxTokens,
    });
  }
  if (!input.query || input.query.trim().length === 0) {
    throw new AppError('E_INVALID', 'query 不能为空');
  }
  const budget = Math.max(200, Math.min(requested, cfg.budget.maxTokens));
  const scope: Scope = input.scope ?? 'all';
  const includeWeak = input.includeWeak ?? true;
  const userId = await getUserId(ctx);
  const now = ctx.now();
  const recentCutoff = new Date(now.getTime() - cfg.life.recentTtlDays * 86_400_000);

  const recentRows = await ctx.sql<Array<{ event_id: number; keywords: string[] }>>`
    SELECT event_id, keywords FROM mem_card
    WHERE user_id = ${userId} AND deleted_at IS NULL AND is_skeleton = false
      AND created_at >= ${recentCutoff}
    ORDER BY created_at DESC
    LIMIT ${cfg.life.recentLimit}`;

  const recentIndex = recentRows.map((r) => ({
    event_id: Number(r.event_id),
    keywords: (r.keywords ?? []).slice(0, 3),
  }));

  const seed = await extractSeeds(ctx, userId, input.query);
  const sub = await buildSubgraph(ctx, seed.ids);
  const ppr = personalizedPageRank(sub.nodes, sub.edges, seed.weights);

  const termRanks = [...sub.nodes]
    .map((id) => ({ id, ppr: ppr.get(id) ?? 0 }))
    .sort((a, b) => b.ppr - a.ppr);
  const ranked = termRanks.slice(0, 60);

  const termRows =
    ranked.length > 0
      ? await ctx.sql<TermRow[]>`
          SELECT id, name, kind, df, heat, heat_at, last_hit_at, aliases FROM term
          WHERE id IN (${ranked.map((r) => r.id)}) AND deleted_at IS NULL`
      : [];
  const termById = new Map(termRows.map((r) => [Number(r.id), r]));

  const dfPassed = ranked.filter((r) => {
    const term = termById.get(r.id);
    if (!term) return false;
    // 种子词必留，扩散词要求 df≥2（4.3：df<2 不参与扩散）
    return seed.weights.has(r.id) || Number(term.df) >= 2;
  });
  const selectedTerms = dfPassed.slice(0, 20);

  const scopeFilter = ctx.sql.raw(
    scope === 'person'
      ? "AND c.category = 'person'"
      : scope === 'project'
        ? "AND c.category <> 'person'"
        : '',
  );

  // 权重表用 JS 侧聚合：SQLite 没有 unnest 派生表，按 term 分组的写法无法两端共用
  const cardRows: CardRow[] = [];
  if (selectedTerms.length > 0) {
    const scoreOf = new Map(selectedTerms.map((t) => [t.id, t.ppr]));
    const flat = await ctx.sql<Array<Record<string, unknown>>>`
      SELECT ct.card_id, ct.term_id, ct.weight,
             c.id AS card_id_ref, c.event_id, c.summary, c.intent, c.keywords, c.entities,
             c.importance, c.confidence, c.use_count, c.hit_count,
             c.heat, c.heat_at, c.last_hit_at, c.created_at, c.is_skeleton,
             c.stale_at, c.source, c.category
      FROM card_term ct
      JOIN mem_card c ON c.id = ct.card_id
      WHERE ct.term_id IN (${selectedTerms.map((t) => t.id)})
        AND c.user_id = ${userId} AND c.deleted_at IS NULL AND c.status <> 'pending'
        ${scopeFilter}`;
    const agg = new Map<number, { row: CardRow; ppr: number; terms: Set<number> }>();
    for (const item of flat) {
      const cardId = Number(item.card_id);
      let entry = agg.get(cardId);
      if (!entry) {
        entry = {
          row: {
            id: cardId,
            event_id: Number(item.event_id),
            summary: String(item.summary),
            intent: (item.intent as string | null) ?? null,
            keywords: (item.keywords as string[]) ?? [],
            entities: (item.entities as string[]) ?? [],
            importance: Number(item.importance),
            heat: Number(item.heat),
            heat_at: item.heat_at as Date,
            last_hit_at: (item.last_hit_at as Date | null) ?? null,
            created_at: item.created_at as Date,
            is_skeleton: Boolean(item.is_skeleton),
            stale_at: (item.stale_at as Date | null) ?? null,
            source: String(item.source),
            category: String(item.category),
            use_count: Number(item.use_count ?? 0),
            hit_count: Number(item.hit_count ?? 0),
            confidence: Number(item.confidence ?? 0.8),
          },
          ppr: 0,
          terms: new Set<number>(),
        };
        agg.set(cardId, entry);
      }
      entry.ppr += Number(item.weight) * (scoreOf.get(Number(item.term_id)) ?? 0);
      entry.terms.add(Number(item.term_id));
    }
    const ordered = [...agg.values()].sort((a, b) => b.ppr - a.ppr).slice(0, 60);
    for (const entry of ordered) {
      cardRows.push({ ...entry.row, ppr_score: entry.ppr, overlap: entry.terms.size });
    }
  }

  const maxPpr = cardRows.reduce((m, r) => Math.max(m, Number(r.ppr_score ?? 0)), 0);

  const coldIds: number[] = [];
  const scored = cardRows.map((row) => {
    const heat = heatNow(ctx, row, cfg.life.cardHalfLifeDays);
    // 新鲜度按「最近一次被命中」算：被反复用到的旧卡不该因为年头长就被判死
    const ageDays = daysBetween(new Date(row.last_hit_at ?? row.created_at), now);
    const pprNorm = maxPpr > 0 ? Number(row.ppr_score ?? 0) / maxPpr : 0;
    const overlap = Number(row.overlap ?? 0);
    const cold = isCold({
      heat,
      lastTouchedAt: new Date(row.last_hit_at ?? row.created_at),
      now,
      coldHeatThreshold: cfg.life.coldHeat,
      coldIdleDays: cfg.life.coldDays,
    });
    if (cold) coldIds.push(Number(row.id));
    return {
      row,
      heat,
      pprNorm,
      overlap,
      cold,
      score:
        cardScore({ pprNorm, ageDays, heat, importance: Number(row.importance) }) *
        precisionFactor(Number(row.use_count ?? 0), Number(row.hit_count ?? 0)),
      strong: isStrong({ pprNorm, ageDays, overlap }),
    };
  });

  const coldSet = new Set(coldIds);
  const strongItems: PackItem[] = [];
  const strongMeta = new Map<string, (typeof scored)[number]>();
  for (const item of scored) {
    if (item.cold || !item.strong) continue;
    const key = `card:${item.row.id}`;
    const text = `[卡#${item.row.id} ${dateLabel(item.row.created_at)}] ${item.row.summary}`;
    strongItems.push(
      makePackItem({
        key,
        kind: 'card',
        tier: 10,
        score: item.score,
        text,
        truncatable: false,
        meta: { card_id: Number(item.row.id) },
      }),
    );
    strongMeta.set(key, item);
  }

  const weakCandidates = scored
    .filter((item) => !item.cold && !item.strong)
    .sort((a, b) => b.score - a.score);
  const weakLimit = includeWeak ? cfg.budget.weakHintLimit : 0;
  const weakItems = weakCandidates.slice(0, weakLimit);
  const weakTrimmed = weakCandidates.slice(weakLimit);

  // L1 常驻块只在会话开始时由 memory.start 注入；recall 只按预算装入事件卡
  const cardPack = pack(strongItems, budget);
  const blocksOut: RecallBlockOut[] = [];
  const recentIndexOut: Array<{ event_id: number; keywords: string[] }> = recentIndex;

  const cardsOut: RecallCardOut[] = [];
  const hitCardIds: number[] = [];
  for (const item of cardPack.included) {
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    const scoredItem = strongMeta.get(item.key);
    if (!scoredItem) continue;
    const row = scoredItem.row;
    cardsOut.push({
      id: Number(row.id),
      event_id: Number(row.event_id),
      summary: row.summary,
      intent: row.intent,
      keywords: row.keywords ?? [],
      entities: row.entities ?? [],
      importance: Number(row.importance),
      heat: round(scoredItem.heat),
      score: scoredItem.score,
      tokens: item.tokens,
      stale: row.stale_at !== null,
      skeleton: row.is_skeleton,
      source: row.source,
      confidence: Number(row.confidence ?? 0.8),
    });
    hitCardIds.push(Number(row.id));
  }

  // hints 与 cards 互斥：已被装进 cards 的卡不再出现在提示行
  const hintCardIds = new Set(hitCardIds);
  const hints: RecallHint[] = weakItems
    .filter((item) => !hintCardIds.has(Number(item.row.id)))
    .map((item) => ({
      card_id: Number(item.row.id),
      summary: item.row.summary,
      text: `提示：你可能问过「${clampText(item.row.summary, 24)}」（卡#${item.row.id}，需要时再展开）`,
    }));

  // 空召回兜底：没有实词种子时给最近记录 + 明确提示，而不是静默返回空
  let note: string | undefined;
  if (seed.matched.length === 0) {
    const fallbackRows = await ctx.sql<Array<{ id: number; summary: string }>>`
      SELECT id, summary FROM mem_card
      WHERE user_id = ${userId} AND deleted_at IS NULL AND status = 'ready' AND is_skeleton = false
      ORDER BY created_at DESC
      LIMIT 3`;
    for (const row of fallbackRows) {
      const fallbackId = Number(row.id);
      if (hintCardIds.has(fallbackId) || hints.some((hint) => hint.card_id === fallbackId)) continue;
      hints.push({
        card_id: fallbackId,
        summary: row.summary,
        text: `最近记录：${clampText(row.summary, 60)}（卡#${fallbackId}）`,
      });
    }
    note =
      '未命中实词种子：query 既没有词典命中，分词也没有匹配。已列出最近记录；建议补充名词/专名（产品、技术、人名等）后重试。';
  }

  // 5.5：stale 卡命中时先登记重算任务（同步重算成本高，降级为返回旧值 + 标记）
  const staleEventIds = scored
    .filter((item) => item.strong && item.row.stale_at !== null && !item.cold)
    .map((item) => Number(item.row.event_id));
  if (staleEventIds.length > 0) {
    const jobRows = uniq(staleEventIds).map((eventId): unknown[] => [
      eventId,
      0,
      ctx.now(),
      'stale 命中重算',
      'pending',
    ]);
    await ctx.sql`
      INSERT INTO condense_job (event_id, attempts, next_at, last_error, status)
      VALUES ${ctx.sql.values(jobRows)}
      ON CONFLICT (event_id) DO NOTHING`;
  }

  const dropped: RecallDropped[] = cardPack.dropped.map((d) => ({
    key: d.key,
    kind: d.kind,
    tokens: d.tokens,
    reason: d.reason,
  }));
  for (const id of coldIds) {
    dropped.push({ key: `card:${id}`, kind: 'card', tokens: 0, reason: 'cold' });
  }
  // 被 weakHintLimit 挡掉的弱关联卡：不进上下文，但要让调用方看得到
  for (const item of weakTrimmed) {
    dropped.push({
      key: `card:${item.row.id}`,
      kind: 'card',
      tokens: estimateTokens(`[卡#${item.row.id}] ${item.row.summary}`),
      reason: 'weak_trimmed',
    });
  }
  // 词侧截断按聚合记：逐条列会一次冒出几十行，反而看不清
  if (termRanks.length > ranked.length) {
    dropped.push({
      key: 'terms:limit60',
      kind: 'term',
      tokens: 0,
      reason: 'limit_truncated',
      count: termRanks.length - ranked.length,
    });
  }
  if (ranked.length > dfPassed.length) {
    dropped.push({
      key: 'terms:df_filtered',
      kind: 'term',
      tokens: 0,
      reason: 'df_filtered',
      count: ranked.length - dfPassed.length,
    });
  }
  if (dfPassed.length > selectedTerms.length) {
    dropped.push({
      key: 'terms:top20',
      kind: 'term',
      tokens: 0,
      reason: 'limit_truncated',
      count: dfPassed.length - selectedTerms.length,
    });
  }

  // 召回只算曝光：卡不加热、不计采用。词仍按命中累加——词的热度衡量词典活跃度，不是采用率
  if (hitCardIds.length > 0) {
    await recordCardHit(ctx, hitCardIds);
    await touchTermHeat(ctx, selectedTerms.map((t) => t.id), 1.0);
  }
  const used = cardPack.used;
  const droppedCount = dropped.length;
  const truncated = dropped.some((item) => item.reason === 'budget');
  const debug = input.debug === true;
  const elapsedMs = Date.now() - started;

  // 落库快照供 memory.inspect 只读回看；重跑 recall 会 touch 热度，不能作为观测手段
  const recallId = await saveInjection(ctx, userId, {
    query: input.query,
    scope,
    budgetLimit: budget,
    budgetUsed: used,
    truncated,
    blocks: blocksOut,
    cards: cardsOut,
    hints,
    dropped,
    droppedCount,
    elapsedMs,
  });

  return {
    query: input.query,
    scope,
    budget_limit: budget,
    budget_used: used,
    blocks: blocksOut,
    recent_index: recentIndexOut,
    cards: cardsOut,
    hints,
    // 明细只在 debug 时返回，避免默认占用上下文
    dropped: debug ? dropped : [],
    dropped_count: droppedCount,
    truncated,
    stale_refresh_queued: staleEventIds.length,
    ...(recallId === null ? {} : { recall_id: recallId }),
    ...(debug
      ? {
          trace: {
            seeds: seed.matched,
            terms: selectedTerms
              .map((t) => ({ id: t.id, name: termById.get(t.id)?.name ?? String(t.id), ppr: round(t.ppr) }))
              .slice(0, 12),
            candidates: cardRows.length,
            elapsed_ms: elapsedMs,
          },
          injection_order: ['cards', 'hints', 'recent_index'],
        }
      : {}),
    ...(note ? { note } : {}),
  };
}

/* ------------------------------------------------------------------ start */

export interface StartHookCheck {
  settings_path: string;
  event: 'SessionStart';
  matcher: string;
  script: string;
  skill_block_id: number;
  instruction: string;
}

export interface StartResult {
  recall_id?: number;
  blocks: RecallBlockOut[];
  /** 仅需要会话钩子自检的客户端会拿到；DSH 组合包用 HOOK_CHECK=off 关掉 */
  hook_check?: StartHookCheck;
  protocol: string;
  budget_used: number;
  /** 整理压力：只给结论与一句话，明细走 memory.sleep */
  maintenance: { level: 'low' | 'medium' | 'high'; hint: string };
  /** 不算压力、但值得人知道一次的变动，例如巡检下线过经验 */
  notices?: string[];
}

/**
 * 会话初始化：L1 常驻块（persona / rules / 经验索引）唯一注入点。
 * 后续 memory.recall 不再重复返回 L1，只按预算取事件卡与滚动索引。
 */
export async function startSession(ctx: Ctx, userId: number): Promise<StartResult> {
  return buildStart(ctx, userId, true);
}

/** 网页预览用：组装逻辑相同，但不落注入快照、不刷新块的使用计数 */
export async function startPreview(ctx: Ctx, userId: number): Promise<StartResult> {
  return buildStart(ctx, userId, false);
}

async function buildStart(ctx: Ctx, userId: number, persist: boolean): Promise<StartResult> {
  const started = Date.now();
  // 会话钩子自检只对 CodeBuddy 这类没有原生技能加载的客户端有意义；
  // DSH 走原生 skills，多一条指令只会让它去查一个不存在的路径，所以组合包里关掉。
  const hookCheck: StartHookCheck | undefined =
    process.env.HOOK_CHECK === 'off'
      ? undefined
      : {
          settings_path: '~/.codebuddy/settings.json',
          event: 'SessionStart',
          matcher: 'startup',
          script: '~/.codebuddy/hooks/mem-recall-gate.py',
          skill_block_id: 123,
          instruction:
            '读取本机 settings.json，确认 hooks.SessionStart 数组元素为 {"matcher":"startup","hooks":[{"type":"command","command":"<指向该脚本>"}]} 形式（command 必须包在 hooks 数组内，不能与 matcher 同级直放）、脚本文件存在；任一缺失则按 #123 技能安装并复验。',
        };
  const pressure = await sleepPressure(ctx, userId);

  // 下线是软删、只留审计：不主动说一句，人只会觉得"这条我好像写过"
  const evictRows = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM mem_audit
    WHERE user_id = ${userId} AND object_type = 'block' AND op = 'evict'
      AND created_at >= ${new Date(ctx.now().getTime() - 7 * 86_400_000)}`;
  const evicted7d = Number(evictRows[0]?.n ?? 0);
  const notices: string[] =
    evicted7d > 0
      ? [`近 7 天有 ${evicted7d} 条经验被巡检下线，可在审计日志里按 block / evict 查`]
      : [];

  const rows = await listBlocks(ctx, userId);
  const { items, skills } = buildL1Items(rows);
  const skillIndex = buildSkillIndex(skills, {
    maxItems: ctx.cfg.life.skillIndexLimit,
    maxTokens: ctx.cfg.life.skillL1MaxTokens,
  });

  const blocksOut: RecallBlockOut[] = items.map((item) => {
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    return {
      label: String(meta.label ?? ''),
      slot: meta.slot === undefined ? undefined : String(meta.slot),
      text: item.text,
      tokens: item.tokens,
      source: meta.source === undefined ? undefined : String(meta.source),
      block_id: meta.block_id as number | undefined,
      ref_terms: meta.ref_terms as number[] | undefined,
      ref_cards: meta.ref_cards as number[] | undefined,
    };
  });
  if (skillIndex.text.length > 0) {
    blocksOut.push({
      label: 'skills',
      slot: 'index',
      text: skillIndex.text,
      tokens: estimateTokens(skillIndex.text),
    });
  }

  const used = blocksOut.reduce((sum, block) => sum + block.tokens, 0);
  const blockIds = [
    ...items.map((item) => Number(item.meta?.block_id ?? 0)),
    ...skillIndex.blockIds,
  ].filter((id) => id > 0);
  if (persist && blockIds.length > 0) await touchBlockUsed(ctx, blockIds);

  let recallId: number | null = null;
  if (persist) {
    recallId = await saveInjection(ctx, userId, {
      query: '初始化记忆加载',
      scope: 'all',
      budgetLimit: 0,
      budgetUsed: used,
      truncated: false,
      blocks: blocksOut,
      cards: [],
      hints: [],
      dropped: [],
      droppedCount: 0,
      elapsedMs: Date.now() - started,
    });
  }

  return {
    ...(recallId === null ? {} : { recall_id: recallId }),
    blocks: blocksOut,
    ...(hookCheck === undefined ? {} : { hook_check: hookCheck }),
    protocol:
      'L1 常驻块只由 memory.start 在新会话开始时注入一次；本会话后续 memory.recall 只返回事件卡、提示行与滚动索引。用户说「初始化记忆」「初始化记忆 mcp」时立即重新调用 memory.start 刷新。',
    budget_used: used,
    maintenance: { level: pressure.level, hint: pressure.hint },
    ...(notices.length === 0 ? {} : { notices }),
  };
}

/* -------------------------------------------------------------- injection 快照 */

/** 每个用户保留的快照条数：够回溯几轮，又不会让观测表无限增长 */
const INJECTION_KEEP = 50;

interface InjectionInput {
  query: string;
  scope: Scope;
  budgetLimit: number;
  budgetUsed: number;
  truncated: boolean;
  blocks: RecallBlockOut[];
  cards: RecallCardOut[];
  hints: RecallHint[];
  dropped: RecallDropped[];
  droppedCount: number;
  elapsedMs: number;
}

/** 快照是辅助观测数据：写失败只丢观测能力，绝不能让召回整体失败。 */
async function saveInjection(
  ctx: Ctx,
  userId: number,
  input: InjectionInput,
): Promise<number | null> {
  try {
    const rows = await ctx.sql<Array<{ id: number }>>`
      INSERT INTO mem_injection (
        user_id, query, scope, budget_limit, budget_used, truncated,
        blocks, cards, hints, dropped, dropped_count, elapsed_ms
      ) VALUES (
        ${userId}, ${input.query}, ${input.scope}, ${input.budgetLimit}, ${input.budgetUsed},
        ${input.truncated},
        ${ctx.sql.json(input.blocks as never)},
        ${ctx.sql.json(input.cards as never)},
        ${ctx.sql.json(input.hints as never)},
        ${ctx.sql.json(input.dropped as never)},
        ${input.droppedCount}, ${input.elapsedMs}
      )
      RETURNING id`;
    const id = rows[0]?.id;
    // 只留最近 INJECTION_KEEP 条：offset 之前的那条 id 即为水位线
    await ctx.sql`
      DELETE FROM mem_injection
      WHERE user_id = ${userId}
        AND id < COALESCE((
          SELECT id FROM mem_injection
          WHERE user_id = ${userId}
          ORDER BY id DESC OFFSET ${INJECTION_KEEP - 1} LIMIT 1
        ), 0)`;
    return id === undefined ? null : Number(id);
  } catch {
    return null;
  }
}

export interface InspectInput {
  userId: number;
  /** 不传则取该用户最近一次召回 */
  recallId?: number;
  /** dropped 明细最多返回多少条（默认 50） */
  limit?: number;
}

export interface InspectResult {
  recall_id: number;
  query: string;
  scope: string;
  created_at: string;
  budget_limit: number;
  budget_used: number;
  budget_utilization: number;
  truncated: boolean;
  elapsed_ms: number | null;
  /** 实际注入的 L1 常驻块（含全文，便于核对是否被截断） */
  blocks: Array<{ label: string; slot?: string; tokens: number; block_id?: number; text: string }>;
  cards: Array<{ card_id: number; tokens: number; score: number; summary: string }>;
  hints: Array<{ card_id: number; text: string }>;
  dropped: RecallDropped[];
  dropped_count: number;
  /** 各列表的总条数（dropped 超出 limit 时据此判断被截了多少） */
  totals: { blocks: number; cards: number; hints: number; dropped: number };
  note: string;
}

interface InjectionRow {
  id: number;
  query: string;
  scope: string;
  budget_limit: number;
  budget_used: number;
  truncated: boolean;
  blocks: RecallBlockOut[] | null;
  cards: RecallCardOut[] | null;
  hints: RecallHint[] | null;
  dropped: RecallDropped[] | null;
  dropped_count: number;
  elapsed_ms: number | null;
  created_at: Date;
}

/**
 * 只读回看某一次召回的注入内容与裁剪原因。
 * 不重新召回、不改热度——这正是它存在的原因：重跑 recall 会污染要观察的信号。
 */
export async function inspect(ctx: Ctx, input: InspectInput): Promise<InspectResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const cols = ctx.sql.raw(`
    id, query, scope, budget_limit, budget_used, truncated,
    blocks, cards, hints, dropped, dropped_count, elapsed_ms, created_at`);
  const rows =
    input.recallId === undefined
      ? await ctx.sql<InjectionRow[]>`
          SELECT ${cols} FROM mem_injection
          WHERE user_id = ${input.userId}
          ORDER BY id DESC LIMIT 1`
      : await ctx.sql<InjectionRow[]>`
          SELECT ${cols} FROM mem_injection
          WHERE user_id = ${input.userId} AND id = ${input.recallId}`;

  const row = rows[0];
  if (!row) {
    throw new AppError(
      'E_TARGET_NOT_FOUND',
      input.recallId === undefined
        ? '还没有注入快照：先调用一次 memory.recall'
        : `注入快照 ${input.recallId} 不存在`,
      { field: 'recall_id', value: input.recallId ?? null },
    );
  }

  const blocks = (row.blocks ?? []).map((block) => ({
    label: block.label,
    ...(block.slot === undefined ? {} : { slot: block.slot }),
    tokens: block.tokens,
    ...(block.block_id === undefined ? {} : { block_id: block.block_id }),
    text: block.text,
  }));
  const cards = (row.cards ?? []).map((card) => ({
    card_id: card.id,
    tokens: card.tokens,
    score: card.score,
    summary: card.summary,
  }));
  const hints = (row.hints ?? []).map((hint) => ({ card_id: hint.card_id, text: hint.text }));
  const allDropped = row.dropped ?? [];
  const budgetLimit = Number(row.budget_limit);
  const budgetUsed = Number(row.budget_used);

  return {
    recall_id: Number(row.id),
    query: row.query,
    scope: row.scope,
    created_at: new Date(row.created_at).toISOString(),
    budget_limit: budgetLimit,
    budget_used: budgetUsed,
    budget_utilization: round(budgetLimit > 0 ? budgetUsed / budgetLimit : 0),
    truncated: row.truncated,
    elapsed_ms: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    blocks,
    cards,
    hints,
    dropped: allDropped.slice(0, limit),
    dropped_count: Number(row.dropped_count),
    totals: {
      blocks: blocks.length,
      cards: cards.length,
      hints: hints.length,
      dropped: allDropped.length,
    },
    note: '这是落库的注入快照：不会重新召回，也不改变热度信号。重跑 recall 会把命中热度 +1，导致观测失真。',
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function dateLabel(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ------------------------------------------------------------------ expand */

export interface ExpandInput {
  cardId?: number;
  /** 经验块 id（mem_block.id）：回取 skills 正文（L1 只给索引） */
  blockId?: number;
  term?: string | number;
  depth?: number;
  limit?: number;
  actor?: Actor;
}

export interface RawRef {
  raw_id: number;
  seq: number;
  role: string;
  content: string;
  ts: Date;
  archived: boolean;
}

export interface ExpandResult {
  card: (CardRow & { terms: Array<{ id: number; name: string; kind: string; role: string }> }) | null;
  /** 按 block_id 取回的经验块正文（L1 只注入索引） */
  block: {
    id: number;
    label: string;
    slot: string;
    /** 一句话描述：这个技能是干什么的 */
    summary: string | null;
    /** 详细描述 */
    content: string;
    tokens: number;
    source: string;
    char_limit: number;
    version: number;
    heat: number;
    /** 累计被取用次数 */
    use_count: number;
    ref_terms: number[];
    ref_cards: number[];
  } | null;
  term: { id: number; name: string; kind: string; df: number; heat: number; aliases: string[] } | null;
  neighbors: Array<{ id: number; name: string; kind: string; df: number; heat: number; type: string; weight: number }>;
  cards: Array<{ id: number; event_id: number; summary: string; intent: string | null; heat: number; skeleton: boolean }>;
  raw_refs: RawRef[];
  next: { term_ids: number[]; card_ids: number[] };
  note?: string;
}

/** FR-08：按 card_id 或 term 展开一跳，返回下层内容与可继续下钻的 ID，并携带 L3 原文引用。 */
export async function expand(ctx: Ctx, input: ExpandInput): Promise<ExpandResult> {
  const cfg = ctx.cfg;
  const userId = await getUserId(ctx);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
  const depth = Math.max(1, Math.min(input.depth ?? 1, 2));
  if (depth > 1) {
    // 首版一跳；两跳在 Web 端由连续调用完成（每次下钻仍保证可溯源）
  }

  // L1 里的经验只给索引（条件 + block_id），正文在这里按 id 取回
  if (input.blockId !== undefined && input.blockId !== null) {
    const rows = await ctx.sql<BlockRow[]>`
      SELECT id, label, slot, summary, content, char_limit, read_only, source, heat, heat_at,
             last_used_at, ref_terms, ref_cards, version, use_count
      FROM mem_block
      WHERE id = ${input.blockId} AND user_id = ${userId} AND deleted_at IS NULL`;
    const block = rows[0];
    if (!block) throw new AppError('E_TARGET_NOT_FOUND', `经验块 ${input.blockId} 不存在`);

    const refCards = (block.ref_cards ?? []).map(Number);
    const refTerms = (block.ref_terms ?? []).map(Number);
    const relatedCards =
      refCards.length > 0
        ? await ctx.sql<Array<{ id: number; event_id: number; summary: string; intent: string | null; heat: number; is_skeleton: boolean }>>`
            SELECT id, event_id, summary, intent, heat, is_skeleton FROM mem_card
            WHERE id IN (${refCards})
              AND user_id = ${userId} AND deleted_at IS NULL
            ORDER BY heat DESC
            LIMIT ${limit}`
        : [];

    // 这里是真的取用正文：计一次调用并涨热度（只看索引不计）
    await touchBlockUsed(ctx, [Number(block.id)], true);

    return {
      card: null,
      block: {
        id: Number(block.id),
        label: block.label,
        slot: block.slot,
        summary: block.summary,
        content: block.content,
        tokens: estimateTokens(block.content),
        source: block.source,
        char_limit: Number(block.char_limit),
        version: Number(block.version),
        heat: round(heatNow(ctx, block, cfg.life.termHalfLifeDays)),
        // touchBlockUsed 刚 +1，回传本次取用后的计数
        use_count: Number(block.use_count ?? 0) + 1,
        ref_terms: refTerms,
        ref_cards: refCards,
      },
      term: null,
      neighbors: [],
      cards: relatedCards.map((c) => ({
        id: Number(c.id),
        event_id: Number(c.event_id),
        summary: c.summary,
        intent: c.intent,
        heat: round(Number(c.heat)),
        skeleton: c.is_skeleton,
      })),
      raw_refs: [],
      next: { term_ids: refTerms, card_ids: refCards },
      ...(block.label === 'skills'
        ? { note: '这是经验的完整条目；执行时以当前上下文为准，条件不满足就不要套用' }
        : {}),
    };
  }

  if (input.cardId !== undefined && input.cardId !== null) {
    const rows = await ctx.sql<CardRow[]>`
      SELECT id, event_id, summary, intent, keywords, entities, importance, heat, heat_at,
             last_hit_at, created_at, is_skeleton, stale_at, source, category
      FROM mem_card
      WHERE id = ${input.cardId} AND user_id = ${userId} AND deleted_at IS NULL`;
    const card = rows[0];
    if (!card) throw new AppError('E_TARGET_NOT_FOUND', `卡 ${input.cardId} 不存在`);

    const termRows = await ctx.sql<Array<{ id: number; name: string; kind: string; role: string }>>`
      SELECT t.id, t.name, t.kind, ct.role
      FROM card_term ct JOIN term t ON t.id = ct.term_id
      WHERE ct.card_id = ${input.cardId} AND t.deleted_at IS NULL
      ORDER BY ct.weight DESC LIMIT ${limit}`;

    let rawRefs: RawRef[] = [];
    if (card.is_skeleton) {
      // FR-16：骨架卡不返回原文引用
    } else {
      rawRefs = (
        await ctx.sql<Array<{ raw_id: number; seq: number; role: string; content: string; ts: Date; archived_at: Date | null }>>`
          SELECT cr.raw_id, r.seq, r.role, r.content, r.ts, r.archived_at
          FROM card_raw cr JOIN mem_raw r ON r.id = cr.raw_id
          WHERE cr.card_id = ${input.cardId}
          ORDER BY r.ts, r.seq
          LIMIT ${limit}`
      ).map((r) => ({
        raw_id: Number(r.raw_id),
        seq: Number(r.seq),
        role: r.role,
        content: r.content,
        ts: new Date(r.ts),
        archived: r.archived_at !== null,
      }));
    }

    const related = await ctx.sql<Array<{ id: number; event_id: number; summary: string; intent: string | null; heat: number; is_skeleton: boolean }>>`
      SELECT DISTINCT c.id, c.event_id, c.summary, c.intent, c.heat, c.is_skeleton
      FROM card_term a
      JOIN card_term b ON b.term_id = a.term_id AND b.card_id <> a.card_id
      JOIN mem_card c ON c.id = b.card_id AND c.deleted_at IS NULL AND c.status <> 'pending'
      WHERE a.card_id = ${input.cardId}
        AND c.user_id = ${userId}
        AND c.created_at >= ${new Date(ctx.now().getTime() - 30 * 86_400_000)}
      ORDER BY c.heat DESC
      LIMIT ${limit}`;

    await touchCardHeat(ctx, [Number(card.id)], 1.5);
    await touchTermHeat(ctx, termRows.map((t) => Number(t.id)), 1.5);

    return {
      card: { ...card, id: Number(card.id), terms: termRows.map((t) => ({ ...t, id: Number(t.id) })) },
      block: null,
      term: null,
      neighbors: [],
      cards: related.map((c) => ({
        id: Number(c.id),
        event_id: Number(c.event_id),
        summary: c.summary,
        intent: c.intent,
        heat: round(Number(c.heat)),
        skeleton: c.is_skeleton,
      })),
      raw_refs: rawRefs,
      next: {
        term_ids: termRows.map((t) => Number(t.id)),
        card_ids: related.map((c) => Number(c.id)),
      },
      ...(card.is_skeleton
        ? { note: '该卡已淡忘为骨架卡，不再持有原文引用；如需细节请通过其他卡或事件追溯' }
        : {}),
    };
  }

  const termKey = input.term;
  if (termKey === undefined || termKey === null || termKey === '') {
    throw new AppError('E_INVALID', 'expand 需要 card_id、block_id 或 term');
  }

  let termRow: TermRow | undefined;
  if (typeof termKey === 'number') {
    const rows = await ctx.sql<TermRow[]>`
      SELECT id, name, kind, df, heat, heat_at, last_hit_at, aliases FROM term
      WHERE id = ${termKey} AND user_id = ${userId} AND deleted_at IS NULL`;
    termRow = rows[0];
  } else {
    const key = normalize(termKey);
    const aliasHit =
      ctx.sql.dialect === 'pg'
        ? ctx.sql.fragment`aliases && ${ctx.sql.array([key], OID.text)}`
        : ctx.sql.fragment`EXISTS (
            SELECT 1 FROM json_each(term.aliases) a WHERE lower(a.value) = ${key}
          )`;
    const rows = await ctx.sql<TermRow[]>`
      SELECT id, name, kind, df, heat, heat_at, last_hit_at, aliases FROM term
      WHERE user_id = ${userId} AND deleted_at IS NULL
        AND (lower(name) = ${key} OR ${aliasHit})
      LIMIT 1`;
    termRow = rows[0];
  }
  if (!termRow) throw new AppError('E_TARGET_NOT_FOUND', `词 ${String(termKey)} 不存在`);
  const termId = Number(termRow.id);

  const neighborRows = await ctx.sql<
    Array<{ id: number; name: string; kind: string; df: number; heat: number; type: string; weight: number }>
  >`
    SELECT t.id, t.name, t.kind, t.df, t.heat, e.type, e.weight
    FROM term_edge e
    JOIN term t ON t.id = CASE WHEN e.src_id = ${termId} THEN e.dst_id ELSE e.src_id END
    WHERE (e.src_id = ${termId} OR e.dst_id = ${termId}) AND t.deleted_at IS NULL
    ORDER BY t.heat DESC, e.weight DESC
    LIMIT ${limit}`;

  const cardRows = await ctx.sql<Array<{ id: number; event_id: number; summary: string; intent: string | null; heat: number; is_skeleton: boolean }>>`
    SELECT c.id, c.event_id, c.summary, c.intent, c.heat, c.is_skeleton
    FROM card_term ct JOIN mem_card c ON c.id = ct.card_id
    WHERE ct.term_id = ${termId} AND c.deleted_at IS NULL AND c.status <> 'pending'
    ORDER BY c.heat DESC LIMIT ${limit}`;

  await touchTermHeat(ctx, [termId], 1.5);

  return {
    card: null,
    block: null,
    term: {
      id: termId,
      name: termRow.name,
      kind: termRow.kind,
      df: Number(termRow.df),
      heat: round(heatNow(ctx, termRow, cfg.life.termHalfLifeDays)),
      aliases: termRow.aliases ?? [],
    },
    neighbors: neighborRows.map((n) => ({
      id: Number(n.id),
      name: n.name,
      kind: n.kind,
      df: Number(n.df),
      heat: round(Number(n.heat)),
      type: n.type,
      weight: round(Number(n.weight)),
    })),
    cards: cardRows.map((c) => ({
      id: Number(c.id),
      event_id: Number(c.event_id),
      summary: c.summary,
      intent: c.intent,
      heat: round(Number(c.heat)),
      skeleton: c.is_skeleton,
    })),
    next: {
      term_ids: neighborRows.map((n) => Number(n.id)),
      card_ids: cardRows.map((c) => Number(c.id)),
    },
    raw_refs: [],
  };
}

/* ------------------------------------------------------------------ write */

export interface WriteMessage {
  role: string;
  content: string;
  tool_name?: string;
  ts?: string;
}

export interface WriteInput {
  messages: WriteMessage[];
  scope?: string;
  event_id?: number;
  close?: boolean;
  source?: 'user' | 'external';
  actor?: Actor;
  /** 调用方（Agent）直接提供卡字段；关键词优先用这里传的，服务端不做语义抽取 */
  card?: CardOverrides;
  /** 追加目标卡：由调用方（AI）结合上下文判断后传入（推荐路径） */
  append_to?: number;
  /** true 时才启用服务端相似度兜底；默认不自动合并 */
  dedupe?: boolean;
  /** 配合 append_to：append 滚动追加（默认），replace 用本次摘要覆盖 */
  summary_mode?: 'append' | 'replace';
  /** 强制新建事件，不复用同 scope 下最近的未成卡事件 */
  new_event?: boolean;
}

export interface WriteResult {
  event_id: number;
  raw_ids: number[];
  card_pending: boolean;
  card_id: number | null;
  /** 本次写入最终归属的卡（新建或并入）；未成卡时为 null */
  target_card_id: number | null;
  turns: number;
  /** 未成卡时的续写句柄 */
  pending_ref?: { event_id: number; note: string };
  /** true 表示本次内容并入已有卡，而不是新建 */
  appended?: boolean;
  append_reason?: string;
  /** true 表示未传 event_id、续写了同 scope 下最近未成卡的事件 */
  resumed?: boolean;
  error?: string;
}

/**
 * 找出可续写的"未成卡 open 事件"：同 scope、最近创建、尚无卡。
 * 窗口内没有就返回 null（调用方新建事件）。
 */
async function findResumableEvent(
  ctx: Ctx,
  userId: number,
  scope: string,
  now: Date,
  minutes: number,
): Promise<number | null> {
  if (!(minutes > 0)) return null;
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = await ctx.sql<Array<{ id: number }>>`
    SELECT e.id FROM mem_event e
    WHERE e.user_id = ${userId}
      AND e.status = 'open'
      AND e.session_id = ${scope}
      AND e.started_at >= ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM mem_card c WHERE c.event_id = e.id AND c.deleted_at IS NULL
      )
    ORDER BY e.started_at DESC, e.id DESC
    LIMIT 1`;
  return rows[0] ? Number(rows[0].id) : null;
}

export async function write(ctx: Ctx, input: WriteInput): Promise<WriteResult> {
  const userId = await getUserId(ctx);
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new AppError('E_INVALID', 'messages 不能为空', { field: 'messages', accepted_keys: ['messages'] });
  }

  // 先校验 append_to，避免写了一半原文才发现目标卡不存在
  let appendTargetId: number | null = null;
  if (input.append_to !== undefined && input.append_to !== null) {
    const rows = await ctx.sql<Array<{ id: number }>>`
      SELECT id FROM mem_card
      WHERE id = ${input.append_to} AND user_id = ${userId} AND deleted_at IS NULL`;
    if (!rows[0]) {
      throw new AppError('E_TARGET_NOT_FOUND', `卡 ${input.append_to} 不存在或已删除`, {
        field: 'append_to',
        value: input.append_to,
        hint: '用 memory.recall 返回的 cards[].id 作为 append_to',
      });
    }
    appendTargetId = Number(rows[0].id);
  }

  const now = ctx.now();
  let eventId = input.event_id;
  let resumed = false;

  if (eventId !== undefined && eventId !== null) {
    const rows = await ctx.sql<Array<{ id: number }>>`
      SELECT id FROM mem_event WHERE id = ${eventId} AND user_id = ${userId}`;
    if (!rows[0]) throw new AppError('E_TARGET_NOT_FOUND', `事件 ${eventId} 不存在`);
    eventId = Number(rows[0].id);
  } else {
    // 不传 event_id 时先尝试续写同 scope 最近未成卡的事件：
    // 否则每轮单条写入都会新建事件，而轮次阈值按事件内原文条数算，
    // 这些事件永远达不到阈值、永远不成卡，等于写进黑洞。
    const scope = input.scope ?? 'default';
    const resumeId = input.new_event
      ? null
      : await findResumableEvent(ctx, userId, scope, now, ctx.cfg.write.autoResumeMinutes);
    if (resumeId !== null) {
      eventId = resumeId;
      resumed = true;
    } else {
      const title = clampText(
        input.messages.find((m) => m.role === 'user')?.content ?? '未命名事件',
        60,
      );
      const rows = await ctx.sql<Array<{ id: number }>>`
        INSERT INTO mem_event (user_id, session_id, title, status, started_at)
        VALUES (${userId}, ${scope}, ${title}, 'open', ${now})
        RETURNING id`;
      eventId = Number(rows[0]?.id);
    }
  }

  const seqRows = await ctx.sql<Array<{ s: number }>>`
    SELECT COALESCE(MAX(seq), 0) AS s FROM mem_raw WHERE event_id = ${eventId}`;
  let seq = Number(seqRows[0]?.s ?? 0);

  const rawIds: number[] = [];
  for (const message of input.messages) {
    if (typeof message.content !== 'string') throw new AppError('E_INVALID', 'content 必须是字符串');
    seq += 1;
    const rows = await ctx.sql<Array<{ id: number }>>`
      INSERT INTO mem_raw (event_id, user_id, seq, role, content, tool_name, ts, hash)
      VALUES (
        ${eventId}, ${userId}, ${seq}, ${message.role}, ${message.content},
        ${message.tool_name ?? null},
        ${message.ts ? new Date(message.ts) : ctx.now()},
        ${hashContent(message.content)}
      )
      RETURNING id`;
    rawIds.push(Number(rows[0]?.id));
  }

  const countRows = await ctx.sql<Array<{ n: number }>>`
    SELECT count(*) AS n FROM mem_raw WHERE event_id = ${eventId}`;
  const turns = Number(countRows[0]?.n ?? 0);
  // 指定 append_to 时必须立即成卡，否则调用方拿不到目标卡 id
  const shouldCondense =
    input.close === true || turns >= ctx.cfg.write.condenseTurnThreshold || appendTargetId !== null;

  if (!shouldCondense) {
    return {
      event_id: eventId,
      raw_ids: rawIds,
      card_pending: true,
      card_id: null,
      target_card_id: null,
      pending_ref: {
        event_id: eventId,
        note: resumed
          ? '已续写最近未成卡的事件；继续写可省略 event_id，收尾传 close=true'
          : '事件未成卡；继续写传 event_id，成卡后再用 append_to',
      },
      turns,
      ...(resumed ? { resumed: true } : {}),
    };
  }

  try {
    const card = await condenseEvent(ctx, userId, eventId, {
      source: input.source ?? 'user',
      actor: input.actor ?? 'agent',
      card: input.card,
      appendTo: appendTargetId ?? undefined,
      dedupe: input.dedupe,
      summaryMode: input.summary_mode,
    });
    return {
      event_id: eventId,
      raw_ids: rawIds,
      card_pending: false,
      card_id: card.cardId,
      target_card_id: card.cardId,
      turns,
      appended: card.appended,
      append_reason: card.appendReason,
      ...(resumed ? { resumed: true } : {}),
    };
  } catch (err) {
    // 5.1：浓缩失败不得阻塞对话，交由 Worker 指数退避重试
    const message = err instanceof Error ? err.message : String(err);
    await scheduleCondenseRetry(ctx, eventId, message);
    return {
      event_id: eventId,
      raw_ids: rawIds,
      card_pending: true,
      card_id: null,
      target_card_id: appendTargetId,
      pending_ref: { event_id: eventId, note: '成卡失败已排重试；可用 event_id 继续写' },
      turns,
      ...(resumed ? { resumed: true } : {}),
      error: message,
    };
  }
}

/** 一次批量写入最多几组：再多就应该拆成多次调用，避免单次响应过长 */
const WRITE_BATCH_MAX = 20;

export interface WriteBatchItemResult {
  index: number;
  ok: boolean;
  result?: WriteResult;
  error?: { code: string; message: string };
}

export interface WriteBatchResult {
  items: WriteBatchItemResult[];
  ok_count: number;
  failed_count: number;
  /** 本次成功成卡的 id（未成卡的组不出现） */
  card_ids: number[];
}

/**
 * 批量写入：每组是独立的 memory.write（可各带 event_id / append_to / close）。
 * 顺序执行、组间隔离——某组失败只回填该组的 error，不影响其它组，
 * 避免因为一条脏数据让整批重来。要"多轮进同一事件"，那是 write 的 event_id 续写，不是 batch。
 */
export async function writeBatch(
  ctx: Ctx,
  inputs: readonly WriteInput[],
): Promise<WriteBatchResult> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new AppError('E_INVALID', 'items 不能为空', { field: 'items' });
  }
  if (inputs.length > WRITE_BATCH_MAX) {
    throw new AppError('E_INVALID', `一次最多 ${WRITE_BATCH_MAX} 组`, {
      field: 'items',
      max: WRITE_BATCH_MAX,
      received: inputs.length,
    });
  }

  const items: WriteBatchItemResult[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      items.push({ index, ok: true, result: await write(ctx, input) });
    } catch (err) {
      items.push({
        index,
        ok: false,
        error: {
          code: isAppError(err) ? err.code : 'E_INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const cardIds = items
    .map((item) => item.result?.card_id)
    .filter((id): id is number => typeof id === 'number');

  return {
    items,
    ok_count: items.filter((item) => item.ok).length,
    failed_count: items.filter((item) => !item.ok).length,
    card_ids: uniq(cardIds),
  };
}

async function scheduleCondenseRetry(ctx: Ctx, eventId: number, error: string): Promise<void> {
  const maxAttempts = ctx.cfg.write.condenseMaxAttempts;
  const next = new Date(ctx.now().getTime() + 60_000);
  // 退避间隔依赖已有的 attempts 值：interval 写法只有 PG 认，先加计数再按结果算下一次时间
  await ctx.sql`
    INSERT INTO condense_job (event_id, attempts, next_at, last_error, status)
    VALUES (${eventId}, 1, ${next}, ${error}, 'pending')
    ON CONFLICT (event_id) DO UPDATE SET
      attempts = condense_job.attempts + 1,
      last_error = EXCLUDED.last_error,
      status = CASE WHEN condense_job.attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END`;
  const rows = await ctx.sql<Array<{ attempts: number }>>`
    SELECT attempts FROM condense_job WHERE event_id = ${eventId}`;
  const attempts = Number(rows[0]?.attempts ?? 1);
  await ctx.sql`
    UPDATE condense_job SET next_at = ${new Date(ctx.now().getTime() + attempts * 60_000)}
    WHERE event_id = ${eventId}`;
}

export interface CondenseOptions {
  source?: 'user' | 'external' | 'system';
  actor?: Actor;
  /** 调用方提供的卡字段；缺省字段由规则兜底 */
  card?: CardOverrides;
  /** 调用方指定的追加目标卡 */
  appendTo?: number;
  /** true 时启用相似度兜底合并；默认关闭 */
  dedupe?: boolean;
  /** append_to 时摘要策略：append（默认）| replace */
  summaryMode?: 'append' | 'replace';
}

export interface CondenseResult {
  cardId: number;
  summary: string;
  appended: boolean;
  appendReason?: string;
}

/** L3 → L2：事件结束或达轮次阈值时自动浓缩（FR-09）；同主题自动追加到已有卡。 */
export async function condenseEvent(
  ctx: Ctx,
  userId: number,
  eventId: number,
  options: CondenseOptions = {},
): Promise<CondenseResult> {
  const rawRows = await ctx.sql<Array<{ id: number; seq: number; role: string; content: string; tool_name: string | null; ts: Date }>>`
    SELECT id, seq, role, content, tool_name, ts FROM mem_raw
    WHERE event_id = ${eventId}
    ORDER BY seq`;
  if (rawRows.length === 0) throw new AppError('E_TARGET_NOT_FOUND', `事件 ${eventId} 没有明细`);

  const messages: CondenseMessage[] = rawRows.map((r) => ({
    role: r.role,
    content: r.content,
    tool_name: r.tool_name,
  }));

  // 同一事件已有卡 → 只刷新自己，不参与跨事件合并
  const ownRows = await ctx.sql<Array<{ id: number }>>`
    SELECT id FROM mem_card
    WHERE event_id = ${eventId} AND user_id = ${userId} AND deleted_at IS NULL`;
  const ownCardId = ownRows[0] ? Number(ownRows[0].id) : null;

  if (options.appendTo !== undefined && options.appendTo !== ownCardId) {
    const target = await loadAppendTarget(ctx, userId, options.appendTo);
    // 只并入尚未挂到该卡上的原文，避免重复调用把同一段内容追加两次
    const linkedRows = await ctx.sql<Array<{ raw_id: number }>>`
      SELECT raw_id FROM card_raw
      WHERE card_id = ${target.id}
        AND raw_id IN (${rawRows.map((r) => Number(r.id))})`;
    const linked = new Set(linkedRows.map((row) => Number(row.raw_id)));
    const freshRaws = rawRows.filter((row) => !linked.has(Number(row.id)));
    if (freshRaws.length === 0) {
      return { cardId: target.id, summary: target.summary, appended: false, appendReason: '内容已在目标卡中' };
    }
    const partial = composeCard(
      ctx.tokenizer,
      freshRaws.map((r) => ({ role: r.role, content: r.content, tool_name: r.tool_name })),
      options.card ?? {},
    );
    const partialSummary = clampText(partial.summary, 200);
    if ([...partialSummary].length < 40) {
      throw new AppError('E_INVALID', '浓缩结果过短，未能生成有效事件卡');
    }
    return appendToCard(
      ctx,
      userId,
      target,
      eventId,
      freshRaws,
      { ...partial, summary: partialSummary },
      options,
      '调用方指定 append_to',
    );
  }

  const condensed = composeCard(ctx.tokenizer, messages, options.card ?? {});

  const summary = clampText(condensed.summary, 200);
  if ([...summary].length < 40) {
    throw new AppError('E_INVALID', '浓缩结果过短，未能生成有效事件卡');
  }

  // 是否追加由调用方（AI）判断：默认不做启发式合并，只有显式 dedupe=true 才启用兜底
  if (ownCardId === null && options.dedupe === true) {
    const picked = await findAppendTarget(ctx, userId, eventId, summary, condensed);
    if (picked) {
      return appendToCard(ctx, userId, picked.target, eventId, rawRows, condensed, options, picked.reason);
    }
  }

  const rows = await ctx.sql<Array<{ id: number; version: number }>>`
    INSERT INTO mem_card (event_id, user_id, summary, intent, keywords, entities, importance, category, status, source)
    VALUES (
      ${eventId}, ${userId}, ${summary}, ${condensed.intent},
      ${ctx.sql.array(condensed.keywords, OID.text)},
      ${ctx.sql.array(condensed.entities, OID.text)},
      ${condensed.importance}, ${condensed.category}, 'ready', ${options.source ?? 'user'}
    )
    ON CONFLICT (event_id) DO UPDATE SET
      summary = EXCLUDED.summary,
      intent = EXCLUDED.intent,
      keywords = EXCLUDED.keywords,
      entities = EXCLUDED.entities,
      importance = EXCLUDED.importance,
      category = EXCLUDED.category,
      status = 'ready',
      stale_at = NULL,
      version = mem_card.version + 1,
      updated_at = ${ctx.now()}
    RETURNING id, version`;
  const cardId = Number(rows[0]?.id);

  await indexCard(ctx, {
    userId,
    cardId,
    intent: condensed.intent,
    keywords: condensed.keywords,
    entities: condensed.entities,
    rawIds: rawRows.map((r) => Number(r.id)),
  });

  await ctx.sql`
    UPDATE mem_event SET status = 'closed', ended_at = COALESCE(ended_at, ${ctx.now()})
    WHERE id = ${eventId}`;
  await ctx.sql`UPDATE condense_job SET status = 'done' WHERE event_id = ${eventId}`;

  await writeAudit(ctx, {
    userId,
    objectType: 'card',
    objectId: cardId,
    op: 'condense',
    after: { summary, intent: condensed.intent, keywords: condensed.keywords, version: Number(rows[0]?.version ?? 1) },
    actor: options.actor ?? 'system',
    reason: 'L3→L2 自动浓缩',
  });
  await saveVersion(ctx, {
    objectType: 'card',
    objectId: cardId,
    version: Number(rows[0]?.version ?? 1),
    snapshot: { summary, intent: condensed.intent, keywords: condensed.keywords },
    actor: options.actor ?? 'system',
  });

  return { cardId, summary, appended: false };
}

interface AppendTarget {
  id: number;
  summary: string;
  keywords: string[];
  entities: string[];
  intent: string | null;
  importance: number;
  category: string;
  version: number;
}

interface AppendTargetRow extends AppendTarget {
  same_session: boolean;
  heat: number;
}

function toAppendTarget(row: AppendTargetRow): AppendTarget {
  return {
    id: Number(row.id),
    summary: row.summary,
    keywords: row.keywords ?? [],
    entities: row.entities ?? [],
    intent: row.intent,
    importance: Number(row.importance ?? 0.5),
    category: row.category,
    version: Number(row.version ?? 1),
  };
}

const APPEND_LOOKBACK_DAYS = 7;

/**
 * 找出应追加的卡：同会话的卡优先，其次看 7 天内的高热卡。
 * 判定纯函数在 core/dedupe.ts，这里只负责取候选。
 */
async function findAppendTarget(
  ctx: Ctx,
  userId: number,
  eventId: number,
  summary: string,
  condensed: { keywords: string[]; intent: string },
): Promise<{ target: AppendTarget; reason: string } | null> {
  const eventRows = await ctx.sql<Array<{ session_id: string }>>`
    SELECT session_id FROM mem_event WHERE id = ${eventId} AND user_id = ${userId}`;
  const sessionId = eventRows[0]?.session_id ?? 'default';
  const lookback = new Date(ctx.now().getTime() - APPEND_LOOKBACK_DAYS * 86_400_000);

  const rows = await ctx.sql<AppendTargetRow[]>`
    SELECT c.id, c.summary, c.keywords, c.entities, c.intent, c.importance, c.category, c.version,
           c.heat, (e.session_id = ${sessionId}) AS same_session
    FROM mem_card c
    JOIN mem_event e ON e.id = c.event_id
    WHERE c.user_id = ${userId}
      AND c.deleted_at IS NULL
      AND c.status = 'ready'
      AND c.is_skeleton = false
      AND c.event_id <> ${eventId}
      AND (e.session_id = ${sessionId} OR c.created_at > ${lookback})
    ORDER BY (e.session_id = ${sessionId}) DESC, c.heat DESC
    LIMIT 8`;

  const candidates: DedupeCandidate[] = rows.map((row) => ({
    id: Number(row.id),
    summary: row.summary,
    keywords: row.keywords ?? [],
    intent: row.intent,
    sameSession: Boolean(row.same_session),
    version: Number(row.version),
    heat: Number(row.heat),
  }));

  const picked = pickAppendTarget(candidates, {
    summary,
    keywords: condensed.keywords,
    intent: condensed.intent,
  });
  if (!picked) return null;

  const row = rows.find((item) => Number(item.id) === picked.candidate.id);
  if (!row) return null;
  return { target: toAppendTarget(row), reason: picked.decision.reason };
}

async function loadAppendTarget(ctx: Ctx, userId: number, cardId: number): Promise<AppendTarget> {
  const rows = await ctx.sql<AppendTargetRow[]>`
    SELECT id, summary, keywords, entities, intent, importance, category, version,
           heat, false AS same_session
    FROM mem_card WHERE id = ${cardId} AND user_id = ${userId} AND deleted_at IS NULL`;
  const row = rows[0];
  if (!row) throw new AppError('E_TARGET_NOT_FOUND', `卡 ${cardId} 不存在`);
  return toAppendTarget(row);
}

/** 把新事件并入已有卡：摘要滚动追加、关键词/实体取并集、关联新原文并加一次热度。 */
async function appendToCard(
  ctx: Ctx,
  userId: number,
  target: AppendTarget,
  eventId: number,
  rawRows: Array<{ id: number }>,
  condensed: { summary: string; keywords: string[]; entities: string[]; intent: string; importance: number; category: 'general' | 'person' },
  options: CondenseOptions,
  reason: string,
): Promise<CondenseResult> {
  const summary =
    options.summaryMode === 'replace'
      ? clampText(condensed.summary, 200)
      : mergeSummary(target.summary, condensed.summary, 200);
  // 新词优先占位，避免卡已有 8 个词时新信息被整组挤掉
  const keywords = sanitizeKeywords([
    ...target.keywords.slice(0, 5),
    ...condensed.keywords,
    ...target.keywords.slice(5),
  ]);
  const entities = uniq([...target.entities, ...condensed.entities]).slice(0, 5);
  const importance = Math.max(Number(target.importance ?? 0.5), condensed.importance);
  const intent = target.intent ?? condensed.intent;
  const category =
    target.category === 'person' || condensed.category === 'person' ? 'person' : 'general';

  const updated = await ctx.sql<Array<{ version: number }>>`
    UPDATE mem_card SET
      summary = ${summary},
      keywords = ${ctx.sql.array(keywords, OID.text)},
      entities = ${ctx.sql.array(entities, OID.text)},
      intent = ${intent},
      importance = ${importance},
      category = ${category},
      stale_at = NULL,
      updated_at = ${ctx.now()},
      version = version + 1
    WHERE id = ${target.id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING version`;
  const version = Number(updated[0]?.version ?? target.version + 1);

  await indexCard(ctx, {
    userId,
    cardId: target.id,
    intent,
    keywords,
    entities,
    rawIds: rawRows.map((row) => Number(row.id)),
    applyHeat: false,
  });
  await touchCardHeat(ctx, [target.id], 2.0);

  await ctx.sql`
    UPDATE mem_event SET status = 'closed', ended_at = COALESCE(ended_at, ${ctx.now()})
    WHERE id = ${eventId}`;
  await ctx.sql`UPDATE condense_job SET status = 'done' WHERE event_id = ${eventId}`;

  await writeAudit(ctx, {
    userId,
    objectType: 'card',
    objectId: target.id,
    op: 'append',
    before: { summary: target.summary, keywords: target.keywords, version: target.version },
    after: { summary, keywords, version, appended_event: eventId },
    actor: options.actor ?? 'system',
    reason: `事件 ${eventId} 并入：${reason}`,
  });
  await saveVersion(ctx, {
    objectType: 'card',
    objectId: target.id,
    version,
    snapshot: { summary, intent, keywords },
    actor: options.actor ?? 'system',
  });

  return { cardId: target.id, summary, appended: true, appendReason: reason };
}

/* ------------------------------------------------------------------ correct */

export interface CorrectTarget {
  type: 'card' | 'block' | 'term' | 'raw';
  id?: number;
  label?: string;
  slot?: string;
}

export interface CorrectInput {
  target: CorrectTarget;
  patch: Record<string, unknown>;
  reason?: string;
  actor?: Actor;
  userId: number;
}

const CARD_PATCH_FIELDS = [
  'summary',
  'intent',
  'keywords',
  'entities',
  'importance',
  'category',
  'status',
  'pinned',
] as const;

export interface CorrectResult {
  version: number;
  audit_id: number;
  object_id: number;
  /** 非人工写入命中审核名单时为 true，此时内容尚未生效 */
  pending_approval?: boolean;
  candidate_id?: number;
  /** 改的是 L1 常驻块：内容已变，需重新调用 memory.start 才会注入新版本 */
  reload_required?: boolean;
}

export type FeedbackVerdict = 'wrong' | 'irrelevant' | 'helpful';

export interface FeedbackInput {
  userId: number;
  cardId: number;
  verdict: FeedbackVerdict;
  note?: string;
  actor?: Actor;
}

export interface FeedbackResult {
  card_id: number;
  verdict: FeedbackVerdict;
  confidence: number;
  audit_id: number;
}

/**
 * 记忆闭环的纠正入口：只处理"召回内容不对"这一件事。
 * wrong 降可信度、irrelevant 只记噪声票、helpful 视为一次采用。
 * 正常使用不必调用——采用率由 expand 与 append_to 自动累计。
 */
export async function feedback(ctx: Ctx, input: FeedbackInput): Promise<FeedbackResult> {
  const rows = await ctx.sql<Array<{ id: number; confidence: number }>>`
    SELECT id, confidence FROM mem_card
    WHERE id = ${input.cardId} AND user_id = ${input.userId} AND deleted_at IS NULL`;
  const card = rows[0];
  if (!card) throw new AppError('E_TARGET_NOT_FOUND', `卡 ${input.cardId} 不存在`);

  const before = Number(card.confidence ?? 0.8);
  const next =
    input.verdict === 'wrong'
      ? Math.max(0.1, before - 0.2)
      : input.verdict === 'helpful'
        ? Math.min(1, before + 0.1)
        : before;

  if (next !== before) {
    await ctx.sql`
      UPDATE mem_card SET confidence = ${next}, updated_at = ${ctx.now()}
      WHERE id = ${input.cardId}`;
  }
  if (input.verdict === 'helpful') await touchCardHeat(ctx, [input.cardId], 1.0);

  const auditId = await writeAudit(ctx, {
    userId: input.userId,
    objectType: 'card',
    objectId: input.cardId,
    op: 'feedback',
    before: { confidence: before },
    after: { verdict: input.verdict, confidence: next },
    actor: input.actor ?? 'agent',
    reason: input.note,
  });

  return { card_id: input.cardId, verdict: input.verdict, confidence: next, audit_id: auditId };
}

export async function correct(
  ctx: Ctx,
  input: CorrectInput,
): Promise<CorrectResult> {
  const actor = input.actor ?? 'agent';
  if (input.target.type === 'raw') {
    throw new AppError('E_IMMUTABLE_RAW', 'L3 明细只追加，不允许修改；更正请新增记录');
  }

  if (input.target.type === 'card') {
    const id = requireId(input.target.id, 'card');
    const rows = await ctx.sql<CardRow[]>`
      SELECT id, event_id, summary, intent, keywords, entities, importance, heat, heat_at,
             last_hit_at, created_at, is_skeleton, stale_at, source, category
      FROM mem_card WHERE id = ${id} AND user_id = ${input.userId} AND deleted_at IS NULL`;
    const before = rows[0];
    if (!before) throw new AppError('E_TARGET_NOT_FOUND', `卡 ${id} 不存在`);

    const patch: Record<string, unknown> = {};
    for (const field of CARD_PATCH_FIELDS) {
      if (input.patch[field] !== undefined) patch[field] = input.patch[field];
    }
    if (Object.keys(patch).length === 0) {
      throw new AppError('E_INVALID', 'patch 没有可更新字段', {
        field: 'patch',
        accepted_keys: [...CARD_PATCH_FIELDS],
        received_keys: Object.keys(input.patch),
      });
    }
    if (patch.summary !== undefined) {
      const text = String(patch.summary);
      // 与 memory.write 的 card.summary 统一：40–200
      if ([...text].length < 40 || [...text].length > 200) {
        throw new AppError('E_INVALID', 'summary 长度须在 40–200 字之间', {
          field: 'patch.summary',
          min: 40,
          max: 200,
          actual: [...text].length,
        });
      }
    }
    if (patch.keywords !== undefined && !Array.isArray(patch.keywords)) {
      throw new AppError('E_INVALID', 'keywords 必须是字符串数组');
    }

    const columns = Object.keys(patch);
    const updated = await ctx.sql<Array<{ version: number }>>`
      UPDATE mem_card SET ${ctx.sql.assign(patch, columns)}, version = version + 1, updated_at = ${ctx.now()}
      WHERE id = ${id}
      RETURNING version`;
    const version = Number(updated[0]?.version ?? (before.version ?? 1) + 1);
    // 改内容不等于被采用，不给热度；改对了只说明更可信
    await ctx.sql`
      UPDATE mem_card
      SET confidence = CASE WHEN confidence + 0.1 > 1.0 THEN 1.0 ELSE confidence + 0.1 END
      WHERE id = ${id}`;

    const needsReindex =
      patch.keywords !== undefined || patch.entities !== undefined || patch.intent !== undefined;
    if (needsReindex) {
      const fresh = await ctx.sql<CardRow[]>`
        SELECT intent, keywords, entities FROM mem_card WHERE id = ${id}`;
      const row = fresh[0];
      if (row) {
        await indexCard(ctx, {
          userId: input.userId,
          cardId: id,
          intent: row.intent,
          keywords: row.keywords ?? [],
          entities: row.entities ?? [],
          rawIds: [],
          applyHeat: false,
        });
      }
    }

    const auditId = await writeAudit(ctx, {
      userId: input.userId,
      objectType: 'card',
      objectId: id,
      op: 'correct',
      before: serializeCard(before),
      after: patch,
      actor,
      reason: input.reason,
    });
    await saveVersion(ctx, {
      objectType: 'card',
      objectId: id,
      version,
      snapshot: patch,
      actor,
    });
    return { version, audit_id: auditId, object_id: id };
  }

  if (input.target.type === 'block') {
    const label = input.target.label;
    if (!label) {
      throw new AppError('E_INVALID', 'block 需要 label', {
        field: 'target.label',
        accepted_values: ['persona', 'rules', 'skills'],
      });
    }
    const slot = input.target.slot ?? 'default';
    const rows = await ctx.sql<BlockRow[]>`
      SELECT id, label, slot, summary, content, char_limit, read_only, source, heat, heat_at,
             last_used_at, ref_terms, ref_cards, version, use_count
      FROM mem_block
      WHERE user_id = ${input.userId} AND label = ${label} AND slot = ${slot} AND deleted_at IS NULL`;
    const existing = rows[0];

    if (!existing) {
      const slotRows = await ctx.sql<Array<{ slot: string }>>`
        SELECT slot FROM mem_block
        WHERE user_id = ${input.userId} AND label = ${label} AND deleted_at IS NULL
        ORDER BY slot LIMIT 20`;
      const existingSlots = slotRows.map((row) => row.slot);
      const skillSlot = label === 'skills' ? /^skill:(\d+)$/.exec(slot) : null;

      if (!skillSlot) {
        throw new AppError('E_TARGET_NOT_FOUND', `块 ${label}/${slot} 不存在`, {
          field: 'target.slot',
          value: slot,
          existing_slots: existingSlots,
          accepted_slots: label === 'skills' ? ['default', 'skill:<term_id>（该词必须已存在）'] : ['default'],
        });
      }

      const termId = Number(skillSlot[1]);
      const termRows = await ctx.sql<Array<{ id: number }>>`
        SELECT id FROM term WHERE id = ${termId} AND user_id = ${input.userId} AND deleted_at IS NULL`;
      if (!termRows[0]) {
        throw new AppError('E_TARGET_NOT_FOUND', `词 ${termId} 不存在，无法写入 skills/${slot}`, {
          field: 'target.slot',
          value: slot,
          existing_slots: existingSlots,
          accepted_slots: ['default', 'skill:<term_id>'],
          hint: '先用 memory.write 生成包含该词的卡，或改用 default',
        });
      }
    }

    const content = input.patch.content;
    if (typeof content !== 'string') {
      throw new AppError('E_INVALID', 'block patch 需要 content 字符串', {
        field: 'patch.content',
        accepted_keys: ['content', 'summary'],
        received_keys: Object.keys(input.patch),
      });
    }
    // skills 不分 default / skill:<term_id>，一律是"一句话总结 + 详细描述"
    const isSkillBlock = label === 'skills';
    // 技能块取「已有额度与当前配置」的较大者，扩展配置后旧块也能写入更长的详细描述
    const charLimit = isSkillBlock
      ? Math.max(Number(existing?.char_limit ?? 0), ctx.cfg.life.skillDetailMaxChars)
      : existing
        ? Number(existing.char_limit)
        : ctx.cfg.life.skillMaxChars;
    if ([...content].length > charLimit) {
      throw new AppError('E_BLOCK_LIMIT', `${label} 超出字符上限 ${charLimit}，当前 ${[...content].length}`, {
        field: 'patch.content',
        limit: charLimit,
        actual: [...content].length,
      });
    }

    const summaryPatch =
      typeof input.patch.summary === 'string' ? input.patch.summary.trim() : undefined;
    if (summaryPatch !== undefined && [...summaryPatch].length > ctx.cfg.life.skillMaxChars) {
      throw new AppError('E_BLOCK_LIMIT', `技能一句话描述超过 ${ctx.cfg.life.skillMaxChars} 字`, {
        field: 'patch.summary',
        limit: ctx.cfg.life.skillMaxChars,
        actual: [...summaryPatch].length,
      });
    }
    // 技能必须有一句话总结：没传就兜底，保证索引行永远可读
    const summary: string | null = isSkillBlock
      ? summaryPatch && summaryPatch.length > 0
        ? summaryPatch
        : slot === 'default'
          ? clampText(content, ctx.cfg.life.skillMaxChars)
          : clampText(skillCondition(content), ctx.cfg.life.skillMaxChars)
      : null;

    // 三类块都允许调用方写入；是否需人工审核由 BLOCK_APPROVAL_LABELS 决定（默认全部直写）
    const needsApproval = actor !== 'human' && ctx.cfg.blocks.approvalLabels.includes(label);
    if (needsApproval) {
      const candidateId = await queueBlockCandidate(ctx, input.userId, {
        label,
        slot,
        content,
        summary,
        charLimit,
        baseVersion: existing?.version ?? 0,
        actor,
        reason: input.reason,
      });
      return {
        version: existing?.version ?? 0,
        audit_id: 0,
        object_id: existing ? Number(existing.id) : 0,
        pending_approval: true,
        candidate_id: candidateId,
      };
    }

    const source = actor === 'human' ? 'human' : 'agent';

    if (!existing) {
      const termId = Number(slot.split(':')[1]);
      // 带上来源卡指针，便于 G7 追溯与撤销
      const cardRows = await ctx.sql<Array<{ id: number }>>`
        SELECT c.id FROM card_term ct
        JOIN mem_card c ON c.id = ct.card_id
        WHERE ct.term_id = ${termId} AND c.user_id = ${input.userId} AND c.deleted_at IS NULL
        ORDER BY c.heat DESC
        LIMIT 20`;
      const refCards = cardRows.map((row) => Number(row.id));
      const inserted = await ctx.sql<Array<{ id: number; version: number }>>`
        INSERT INTO mem_block (
          user_id, label, slot, summary, content, char_limit, read_only, source,
          heat, heat_at, last_used_at, ref_terms, ref_cards
        )
        VALUES (
          ${input.userId}, 'skills', ${slot}, ${summary}, ${content}, ${charLimit}, false, ${source},
          0.5, ${ctx.now()}, ${ctx.now()},
          ${ctx.sql.array([termId], OID.int8)}, ${ctx.sql.array(refCards, OID.int8)}
        )
        RETURNING id, version`;
      const newId = Number(inserted[0]?.id ?? 0);
      const version = Number(inserted[0]?.version ?? 1);
      const auditId = await writeAudit(ctx, {
        userId: input.userId,
        objectType: 'block',
        objectId: newId,
        op: 'correct',
        after: { label, slot, summary, content, version, source },
        actor,
        reason: input.reason ?? '新建 skills 条目',
      });
      await saveVersion(ctx, {
        objectType: 'block',
        objectId: newId,
        version,
        snapshot: { summary, content },
        actor,
      });
      return { version, audit_id: auditId, object_id: newId, reload_required: true };
    }

    const updated = await ctx.sql<Array<{ version: number }>>`
      UPDATE mem_block
      SET summary = ${summary}, content = ${content}, char_limit = ${charLimit}, source = ${source},
          version = version + 1, updated_at = ${ctx.now()}
      WHERE id = ${existing.id}
      RETURNING version`;
    const version = Number(updated[0]?.version ?? existing.version + 1);

    const auditId = await writeAudit(ctx, {
      userId: input.userId,
      objectType: 'block',
      objectId: Number(existing.id),
      op: 'correct',
      before: {
        summary: existing.summary,
        content: existing.content,
        version: existing.version,
        source: existing.source,
      },
      after: { summary, content, version, source },
      actor,
      reason: input.reason,
    });
    await saveVersion(ctx, {
      objectType: 'block',
      objectId: Number(existing.id),
      version,
      snapshot: { summary, content },
      actor,
    });
    return { version, audit_id: auditId, object_id: Number(existing.id), reload_required: true };
  }

  // term
  const id = requireId(input.target.id, 'term');
  const rows = await ctx.sql<TermRow[]>`
    SELECT id, name, kind, df, heat, heat_at, last_hit_at, aliases FROM term
    WHERE id = ${id} AND user_id = ${input.userId} AND deleted_at IS NULL`;
  const before = rows[0];
  if (!before) throw new AppError('E_TARGET_NOT_FOUND', `词 ${id} 不存在`);

  const patch: Record<string, unknown> = {};
  if (typeof input.patch.name === 'string' && input.patch.name.trim()) {
    patch.name = normalize(String(input.patch.name));
  }
  if (Array.isArray(input.patch.aliases)) {
    patch.aliases = uniq(
      (input.patch.aliases as unknown[])
        .filter((a): a is string => typeof a === 'string')
        .map((a) => normalize(a))
        .filter(Boolean),
    );
  }
  if (typeof input.patch.kind === 'string' && ['entity', 'intent', 'concept'].includes(input.patch.kind)) {
    patch.kind = input.patch.kind;
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError('E_INVALID', 'patch 没有可更新字段', {
      field: 'patch',
      accepted_keys: ['name', 'aliases', 'kind'],
      received_keys: Object.keys(input.patch),
    });
  }

  try {
    const columns = Object.keys(patch);
    await ctx.sql`
      UPDATE term SET ${ctx.sql.assign(patch, columns)} WHERE id = ${id}`;
  } catch (err) {
    if (err instanceof Error && /term_name_uniq|duplicate key/.test(err.message)) {
      throw new AppError('E_CONFLICT', `词名 ${String(patch.name ?? '')} 已存在`, { name: patch.name });
    }
    throw err;
  }

  const auditId = await writeAudit(ctx, {
    userId: input.userId,
    objectType: 'term',
    objectId: id,
    op: 'correct',
    before: { name: before.name, aliases: before.aliases, kind: before.kind },
    after: patch,
    actor,
    reason: input.reason,
  });

  // 5.5 失效传播：实体重命名或合并后，引用它的卡标 stale
  if (patch.name !== undefined || patch.aliases !== undefined) {
    await markStaleByTerm(ctx, id);
    // 改了 name/aliases 可能让同义关系成立或失效，及时重算 alias 边
    await upsertAliasEdges(ctx, [id]);
  }
  return { version: 1, audit_id: auditId, object_id: id };
}

export async function markStaleByTerm(ctx: Ctx, termId: number): Promise<number> {
  const rows = await ctx.sql<Array<{ n: number }>>`
    WITH touched AS (
      UPDATE mem_card SET stale_at = ${ctx.now()}
      WHERE id IN (SELECT card_id FROM card_term WHERE term_id = ${termId})
        AND deleted_at IS NULL
      RETURNING id
    )
    SELECT count(*) AS n FROM touched`;
  return Number(rows[0]?.n ?? 0);
}

function serializeCard(row: CardRow): Record<string, unknown> {
  return {
    summary: row.summary,
    intent: row.intent,
    keywords: row.keywords,
    entities: row.entities,
    importance: row.importance,
    category: row.category,
    status: row.status ?? 'ready',
  };
}

function requireId(id: number | undefined, type: string): number {
  if (id === undefined || id === null || !Number.isFinite(Number(id))) {
    throw new AppError('E_INVALID', `${type} 需要 id`);
  }
  return Number(id);
}

/** 非人工写入命中审核名单时入队；同一 label+slot 只保留一条待审记录。 */
async function queueBlockCandidate(
  ctx: Ctx,
  userId: number,
  input: {
    label: string;
    slot: string;
    content: string;
    summary?: string | null;
    charLimit: number;
    baseVersion: number;
    actor: Actor;
    reason?: string;
  },
): Promise<number> {
  const payload = {
    label: input.label,
    slot: input.slot,
    summary: input.summary ?? null,
    content: input.content,
    char_limit: input.charLimit,
    base_version: input.baseVersion,
  };
  const rows = await ctx.sql<Array<{ id: number }>>`
    INSERT INTO promotion_candidate (user_id, kind, payload, evidence, score, dedupe_key)
    VALUES (${userId}, 'block', ${ctx.sql.json(payload as never)}, ${ctx.sql.array([], OID.int8)}, 1.0,
            ${`block:${input.label}:${input.slot}`})
    ON CONFLICT (user_id, kind, dedupe_key) WHERE status = 'pending'
    DO UPDATE SET payload = EXCLUDED.payload, score = EXCLUDED.score
    RETURNING id`;
  const candidateId = Number(rows[0]?.id ?? 0);
  await writeAudit(ctx, {
    userId,
    objectType: 'candidate',
    objectId: candidateId,
    op: 'block.pending',
    after: payload,
    actor: input.actor,
    reason: input.reason ?? `${input.label} 变更待人工审核`,
  });
  return candidateId;
}

/* ------------------------------------------------------------------ forget */

export interface ForgetTarget {
  type: 'card' | 'block' | 'term' | 'raw';
  id?: number;
  label?: string;
  slot?: string;
}

export interface ForgetInput {
  target: ForgetTarget;
  /** skeleton：压成骨架卡并断开原文，卡还在，只是不再持有细节 */
  mode: 'soft' | 'purge' | 'skeleton';
  confirm?: boolean;
  reason?: string;
  actor?: Actor;
  userId: number;
}

/** S4 / FR-16：区分"不再召回"（软删）与"物理清除"（不可恢复，先进回收站 7 天）。 */
export async function forget(
  ctx: Ctx,
  input: ForgetInput,
): Promise<{ affected: Array<{ type: string; id: number }>; mode: string; trash_id?: number }> {
  const actor = input.actor ?? 'agent';
  const type = input.target.type;

  if (type === 'raw') {
    throw new AppError('E_IMMUTABLE_RAW', 'L3 明细不允许单条删除；由生命周期归档与定期清除');
  }

  if (input.mode === 'skeleton') {
    if (type !== 'card') {
      throw new AppError('E_INVALID', '骨架化只适用于事件卡', {
        field: 'target.type',
        value: type,
      });
    }
    const id = await resolveTargetId(ctx, input.userId, input.target);
    const rows = await ctx.sql<
      Array<{
        id: number;
        summary: string;
        importance: number;
        pinned: boolean | number;
        category: string;
        is_skeleton: boolean | number;
      }>
    >`
      SELECT id, summary, importance, pinned, category, is_skeleton FROM mem_card
      WHERE id = ${id} AND user_id = ${input.userId} AND deleted_at IS NULL`;
    const card = rows[0];
    if (!card) throw new AppError('E_TARGET_NOT_FOUND', `卡 ${id} 不存在`);
    if (Boolean(card.is_skeleton)) return { affected: [{ type, id }], mode: 'skeleton' };
    // 与巡检时代的保护规则一致：重要、钉住、人物关系不压
    if (Boolean(card.pinned) || Number(card.importance) >= 0.8 || card.category === 'person') {
      throw new AppError('E_NOT_APPROVED', '这张卡受保护，不压成骨架', {
        pinned: Boolean(card.pinned),
        importance: Number(card.importance),
        category: card.category,
      });
    }
    const compressed = clampText(card.summary, ctx.cfg.life.skeletonMaxChars);
    await ctx.sql`
      UPDATE mem_card
      SET is_skeleton = true, skeleton_at = ${ctx.now()}, summary = ${compressed},
          updated_at = ${ctx.now()}
      WHERE id = ${id}`;
    // 断开 L3 引用：骨架卡只留结论，细节交回原文层
    await ctx.sql`DELETE FROM card_raw WHERE card_id = ${id}`;
    await writeAudit(ctx, {
      userId: input.userId,
      objectType: 'card',
      objectId: id,
      op: 'forget.skeleton',
      before: { summary: card.summary },
      after: { summary: compressed, skeleton_at: ctx.now().toISOString() },
      actor,
      reason: input.reason ?? '睡眠整理：压成骨架卡',
    });
    return { affected: [{ type, id }], mode: 'skeleton' };
  }

  if (input.mode === 'soft') {
    const id = await resolveTargetId(ctx, input.userId, input.target);
    if (type === 'card') {
      const before = await ctx.sql<CardRow[]>`
        SELECT id, summary FROM mem_card WHERE id = ${id} AND user_id = ${input.userId}`;
      await ctx.sql`
        UPDATE mem_card SET deleted_at = ${ctx.now()}, updated_at = ${ctx.now()}
        WHERE id = ${id} AND user_id = ${input.userId}`;
      await writeAudit(ctx, {
        userId: input.userId,
        objectType: 'card',
        objectId: id,
        op: 'forget.soft',
        before: { summary: before[0]?.summary },
        after: { deleted_at: ctx.now().toISOString() },
        actor,
        reason: input.reason ?? '软删进回收站',
      });
    } else if (type === 'term') {
      await ctx.sql`UPDATE term SET deleted_at = ${ctx.now()} WHERE id = ${id} AND user_id = ${input.userId}`;
      await writeAudit(ctx, {
        userId: input.userId,
        objectType: 'term',
        objectId: id,
        op: 'forget.soft',
        actor,
        reason: input.reason ?? '软删',
      });
    } else {
      await ctx.sql`UPDATE mem_block SET deleted_at = ${ctx.now()} WHERE id = ${id} AND user_id = ${input.userId}`;
      await writeAudit(ctx, {
        userId: input.userId,
        objectType: 'block',
        objectId: id,
        op: 'forget.soft',
        actor,
        reason: input.reason ?? '软删',
      });
    }
    return { affected: [{ type, id }], mode: 'soft' };
  }

  if (input.confirm !== true) {
    throw new AppError('E_NOT_APPROVED', '物理清除需要二次确认（confirm=true）');
  }
  const id = await resolveTargetId(ctx, input.userId, input.target);
  const snapshot = await snapshotObject(ctx, input.userId, type, id);
  if (!snapshot) throw new AppError('E_TARGET_NOT_FOUND', `${type} ${id} 不存在`);
  const purgeAt = new Date(ctx.now().getTime() + ctx.cfg.life.trashRestoreDays * 86_400_000);
  const trashRows = await ctx.sql<Array<{ id: number }>>`
    INSERT INTO mem_trash (user_id, object_type, object_id, snapshot, deleted_by, purge_at)
    VALUES (${input.userId}, ${type}, ${id}, ${ctx.sql.json(snapshot as never)}, ${actor}, ${purgeAt})
    RETURNING id`;

  await deleteObject(ctx, type, id);
  await writeAudit(ctx, {
    userId: input.userId,
    objectType: type,
    objectId: id,
    op: 'forget.purge',
    before: snapshot,
    after: { trash_id: Number(trashRows[0]?.id), purge_at: purgeAt.toISOString() },
    actor,
    reason: input.reason ?? '物理清除',
  });
  return { affected: [{ type, id }], mode: 'purge', trash_id: Number(trashRows[0]?.id) };
}

async function resolveTargetId(ctx: Ctx, userId: number, target: ForgetTarget): Promise<number> {
  if (target.type === 'block') {
    if (target.id !== undefined) return Number(target.id);
    const rows = await ctx.sql<Array<{ id: number }>>`
      SELECT id FROM mem_block
      WHERE user_id = ${userId} AND label = ${target.label ?? ''} AND slot = ${target.slot ?? 'default'}
        AND deleted_at IS NULL`;
    if (!rows[0]) throw new AppError('E_TARGET_NOT_FOUND', '目标块不存在');
    return Number(rows[0].id);
  }
  if (target.id === undefined) throw new AppError('E_INVALID', `${target.type} 需要 id`);
  return Number(target.id);
}

async function snapshotObject(
  ctx: Ctx,
  userId: number,
  type: string,
  id: number,
): Promise<Record<string, unknown> | null> {
  if (type === 'card') {
    const cards = await ctx.sql<Record<string, unknown>[]>`
      SELECT * FROM mem_card WHERE id = ${id} AND user_id = ${userId}`;
    const card = cards[0];
    if (!card) return null;
    const event = await ctx.sql<Record<string, unknown>[]>`
      SELECT * FROM mem_event WHERE id = ${card.event_id as number}`;
    const rawLinks = await ctx.sql<Record<string, unknown>[]>`
      SELECT * FROM card_raw WHERE card_id = ${id}`;
    const termLinks = await ctx.sql<Record<string, unknown>[]>`
      SELECT * FROM card_term WHERE card_id = ${id}`;
    return { card, event: event[0] ?? null, raw_links: rawLinks, term_links: termLinks };
  }
  if (type === 'term') {
    const rows = await ctx.sql<Record<string, unknown>[]>`
      SELECT * FROM term WHERE id = ${id} AND user_id = ${userId}`;
    const term = rows[0];
    if (!term) return null;
    const links = await ctx.sql<Record<string, unknown>[]>`
      SELECT * FROM card_term WHERE term_id = ${id}`;
    return { term, term_links: links };
  }
  const rows = await ctx.sql<Record<string, unknown>[]>`
    SELECT * FROM mem_block WHERE id = ${id} AND user_id = ${userId}`;
  return rows[0] ? { block: rows[0] } : null;
}

async function deleteObject(ctx: Ctx, type: string, id: number): Promise<void> {
  if (type === 'card') {
    await ctx.sql`DELETE FROM mem_card WHERE id = ${id}`;
    return;
  }
  if (type === 'term') {
    await ctx.sql`DELETE FROM term WHERE id = ${id}`;
    return;
  }
  await ctx.sql`DELETE FROM mem_block WHERE id = ${id}`;
}

export interface TrashItem {
  kind: 'soft' | 'snapshot';
  id: number;
  object_type: string;
  object_id: number;
  title: string;
  created_at: Date;
  purge_at?: Date;
}

export async function listTrash(ctx: Ctx, userId: number): Promise<TrashItem[]> {
  const softCards = await ctx.sql<Array<{ id: number; summary: string; deleted_at: Date }>>`
    SELECT id, summary, deleted_at FROM mem_card
    WHERE user_id = ${userId} AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC LIMIT 100`;
  const softTerms = await ctx.sql<Array<{ id: number; name: string; deleted_at: Date }>>`
    SELECT id, name, deleted_at FROM term
    WHERE user_id = ${userId} AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC LIMIT 100`;
  const snapshots = await ctx.sql<Array<{ id: number; object_type: string; object_id: number; snapshot: unknown; created_at: Date; purge_at: Date }>>`
    SELECT id, object_type, object_id, snapshot, created_at, purge_at FROM mem_trash
    WHERE user_id = ${userId} AND restored_at IS NULL
    ORDER BY created_at DESC LIMIT 100`;

  return [
    ...softCards.map((r) => ({
      kind: 'soft' as const,
      id: Number(r.id),
      object_type: 'card',
      object_id: Number(r.id),
      title: r.summary,
      created_at: new Date(r.deleted_at),
    })),
    ...softTerms.map((r) => ({
      kind: 'soft' as const,
      id: Number(r.id),
      object_type: 'term',
      object_id: Number(r.id),
      title: r.name,
      created_at: new Date(r.deleted_at),
    })),
    ...snapshots.map((r) => {
      const snap = r.snapshot as Record<string, Record<string, unknown>> | null;
      const title =
        (snap?.card?.summary as string | undefined) ??
        (snap?.term?.name as string | undefined) ??
        (snap?.block?.content as string | undefined) ??
        `${r.object_type}#${r.object_id}`;
      return {
        kind: 'snapshot' as const,
        id: Number(r.id),
        object_type: r.object_type,
        object_id: Number(r.object_id),
        title: clampText(title, 60),
        created_at: new Date(r.created_at),
        purge_at: new Date(r.purge_at),
      };
    }),
  ];
}

/** 软删恢复：清除 deleted_at。 */
export async function restoreSoft(ctx: Ctx, userId: number, type: string, id: number, actor: Actor = 'human'): Promise<void> {
  if (type === 'card') {
    await ctx.sql`
      UPDATE mem_card SET deleted_at = NULL, updated_at = ${ctx.now()}
      WHERE id = ${id} AND user_id = ${userId}`;
  } else if (type === 'term') {
    await ctx.sql`UPDATE term SET deleted_at = NULL WHERE id = ${id} AND user_id = ${userId}`;
  } else if (type === 'block') {
    await ctx.sql`UPDATE mem_block SET deleted_at = NULL WHERE id = ${id} AND user_id = ${userId}`;
  } else {
    throw new AppError('E_INVALID', `不支持恢复的对象类型 ${type}`);
  }
  await writeAudit(ctx, {
    userId,
    objectType: type as 'card',
    objectId: id,
    op: 'restore',
    actor,
    reason: '从回收站恢复',
  });
}

/** 物理清除后的恢复：从 mem_trash 快照回灌（7 天内）。 */
export async function restoreSnapshot(ctx: Ctx, userId: number, trashId: number, actor: Actor = 'human'): Promise<void> {
  const rows = await ctx.sql<Array<{ object_type: string; object_id: number; snapshot: Record<string, unknown>; restored_at: Date | null }>>`
    SELECT object_type, object_id, snapshot, restored_at FROM mem_trash
    WHERE id = ${trashId} AND user_id = ${userId}`;
  const row = rows[0];
  if (!row) throw new AppError('E_TARGET_NOT_FOUND', `回收站条目 ${trashId} 不存在`);
  if (row.restored_at) throw new AppError('E_CONFLICT', '该条目已恢复');

  const snap = row.snapshot as Record<string, Record<string, unknown> | Record<string, unknown>[] | null>;

  if (row.object_type === 'card') {
    const card = snap.card as Record<string, any> | null;
    const event = snap.event as Record<string, any> | null;
    if (!card) throw new AppError('E_INVALID', '快照不完整');
    if (event) {
      await ctx.sql`
        INSERT INTO mem_event (id, user_id, session_id, title, status, started_at, ended_at)
        VALUES (${Number(event.id)}, ${Number(event.user_id)}, ${event.session_id ?? null},
                ${event.title ?? null}, ${event.status ?? 'closed'},
                ${new Date(String(event.started_at))}, ${event.ended_at ? new Date(String(event.ended_at)) : null})
        ON CONFLICT (id) DO NOTHING`;
      // SQLite 的 AUTOINCREMENT 会自己跳过已用的 id，不需要重置序列
      if (ctx.sql.dialect === 'pg') {
        await ctx.sql`SELECT setval(pg_get_serial_sequence('mem_event','id'), GREATEST((SELECT MAX(id) FROM mem_event), 1))`;
      }
    }
    await ctx.sql`
      INSERT INTO mem_card (id, event_id, user_id, summary, intent, keywords, entities, status, source,
        category, importance, use_count, heat, heat_at, pinned, version, created_at, updated_at)
      VALUES (
        ${Number(card.id)}, ${Number(card.event_id)}, ${Number(card.user_id)}, ${String(card.summary)},
        ${card.intent ?? null}, ${ctx.sql.array((card.keywords as string[]) ?? [], OID.text)},
        ${ctx.sql.array((card.entities as string[]) ?? [], OID.text)}, ${card.status ?? 'ready'},
        ${card.source ?? 'user'}, ${card.category ?? 'general'}, ${card.importance ?? 0.5},
        ${card.use_count ?? 0}, ${card.heat ?? 0}, ${new Date(String(card.heat_at ?? new Date().toISOString()))},
        ${card.pinned ?? false}, ${card.version ?? 1}, ${new Date(String(card.created_at))},
        ${new Date(String(card.updated_at))}
      )
      ON CONFLICT (id) DO NOTHING`;
    if (ctx.sql.dialect === 'pg') {
      await ctx.sql`SELECT setval(pg_get_serial_sequence('mem_card','id'), GREATEST((SELECT MAX(id) FROM mem_card), 1))`;
    }

    for (const link of (snap.term_links as Array<Record<string, any>>) ?? []) {
      await ctx.sql`
        INSERT INTO card_term (card_id, term_id, role, weight)
        SELECT ${Number(link.card_id)}, ${Number(link.term_id)}, ${link.role ?? 'keyword'}, ${link.weight ?? 1}
        WHERE EXISTS (SELECT 1 FROM term WHERE id = ${Number(link.term_id)})
        ON CONFLICT DO NOTHING`;
    }
    for (const link of (snap.raw_links as Array<Record<string, any>>) ?? []) {
      await ctx.sql`
        INSERT INTO card_raw (card_id, raw_id, weight)
        SELECT ${Number(link.card_id)}, ${Number(link.raw_id)}, ${link.weight ?? 1}
        WHERE EXISTS (SELECT 1 FROM mem_raw WHERE id = ${Number(link.raw_id)})
        ON CONFLICT DO NOTHING`;
    }
  } else if (row.object_type === 'term') {
    const term = snap.term as Record<string, any> | null;
    if (!term) throw new AppError('E_INVALID', '快照不完整');
    await ctx.sql`
      INSERT INTO term (id, user_id, name, kind, aliases, df, heat, heat_at, created_at)
      VALUES (${Number(term.id)}, ${Number(term.user_id)}, ${String(term.name)}, ${String(term.kind)},
              ${ctx.sql.array((term.aliases as string[]) ?? [], OID.text)}, ${term.df ?? 0},
              ${term.heat ?? 0}, ${new Date(String(term.heat_at ?? new Date().toISOString()))},
              ${new Date(String(term.created_at ?? new Date().toISOString()))})
      ON CONFLICT (id) DO NOTHING`;
  } else {
    const block = snap.block as Record<string, any> | null;
    if (!block) throw new AppError('E_INVALID', '快照不完整');
    await ctx.sql`
      INSERT INTO mem_block (id, user_id, label, slot, summary, content, use_count, char_limit, read_only, source, heat, heat_at, version, created_at, updated_at)
      VALUES (${Number(block.id)}, ${Number(block.user_id)}, ${String(block.label)}, ${String(block.slot)},
              ${block.summary ?? null},
              ${String(block.content ?? '')}, ${block.use_count ?? 0}, ${block.char_limit ?? 2000}, ${block.read_only ?? false},
              ${block.source ?? 'human'}, ${block.heat ?? 0},
              ${new Date(String(block.heat_at ?? new Date().toISOString()))}, ${block.version ?? 1},
              ${new Date(String(block.created_at ?? new Date().toISOString()))},
              ${new Date(String(block.updated_at ?? new Date().toISOString()))})
      ON CONFLICT (id) DO NOTHING`;
  }

  await ctx.sql`UPDATE mem_trash SET restored_at = ${ctx.now()} WHERE id = ${trashId}`;
  await writeAudit(ctx, {
    userId,
    objectType: row.object_type as 'card',
    objectId: Number(row.object_id),
    op: 'restore.purge',
    actor,
    reason: `从回收站快照 ${trashId} 恢复`,
  });
}
