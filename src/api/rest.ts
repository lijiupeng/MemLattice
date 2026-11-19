import type { FastifyInstance } from 'fastify';
import { AppError } from '../core/errors.js';
import type { CardOverrides } from '../core/condense.js';
import { metricsSnapshot, recordEvent, recordRecall } from '../metrics.js';
import {
  correct,
  expand,
  feedback,
  forget,
  listTrash,
  recall,
  restoreSnapshot,
  restoreSoft,
  startPreview,
  write,
} from '../services/memory.service.js';
import {
  approveCandidate,
  getCardDetail,
  graphData,
  listAudit,
  listBlockDetails,
  listCandidates,
  listCards,
  listTerms,
  listVersions,
  mergeTerms,
  rejectCandidate,
  termSuggestions,
} from '../services/governance.service.js';
import { runPatrol } from '../services/lifecycle.service.js';
import { graphRadial } from '../services/graph.service.js';
import { listSettings, resetSetting, updateSettings } from '../services/settings.service.js';
import { getUserId, type Ctx } from '../services/context.js';
import { assertAuthorized, assertOrigin, bool, num, optionalNum, str, wrap, type Body, type Query } from './http.js';

export function registerRest(app: FastifyInstance, ctx: Ctx): void {
  const guard = async (req: Parameters<typeof assertAuthorized>[0]): Promise<void> => {
    assertOrigin(req, ctx.cfg);
    assertAuthorized(req, ctx.cfg);
  };

  app.get(
    '/api/health',
    wrap(async () => ({
      ok: true,
      service: 'memlattice',
      time: new Date().toISOString(),
      keywords: 'provided-by-caller',
    })),
  );

  app.get(
    '/api/metrics',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const counts = await ctx.sql<
        Array<{
          cards: number;
          terms: number;
          edges: number;
          raws: number;
          blocks: number;
          candidates: number;
          trash: number;
        }>
      >`
        SELECT
          (SELECT count(*) FROM mem_card WHERE user_id = ${userId} AND deleted_at IS NULL) AS cards,
          (SELECT count(*) FROM term WHERE user_id = ${userId} AND deleted_at IS NULL) AS terms,
          (SELECT count(*) FROM term_edge) AS edges,
          (SELECT count(*) FROM mem_raw WHERE user_id = ${userId}) AS raws,
          (SELECT count(*) FROM mem_block WHERE user_id = ${userId} AND deleted_at IS NULL) AS blocks,
          (SELECT count(*) FROM promotion_candidate WHERE user_id = ${userId} AND status = 'pending') AS candidates,
          (SELECT count(*) FROM mem_trash WHERE user_id = ${userId} AND restored_at IS NULL) AS trash`;
      return { ...metricsSnapshot(), counts: counts[0] ?? null, config: {
        budget: ctx.cfg.budget,
        life: ctx.cfg.life,
        write: ctx.cfg.write,
      } };
    }),
  );

  /* ---------------------------------------------------------- 运行时参数 */

  app.get(
    '/api/settings',
    wrap(async (req) => {
      await guard(req);
      return listSettings(ctx);
    }),
  );

  app.put(
    '/api/settings',
    wrap(async (req) => {
      await guard(req);
      const body = (req.body ?? {}) as Body;
      return updateSettings(ctx, body.values, 'human');
    }),
  );

  app.delete(
    '/api/settings/:key',
    wrap(async (req) => {
      await guard(req);
      const key = (req.params as { key: string }).key ?? '';
      return resetSetting(ctx, key, 'human');
    }),
  );

  /* ---------------------------------------------------------- 记忆列表与详情 */

  app.get(
    '/api/cards',
    wrap(async (req) => {
      await guard(req);
      const q = req.query as Query;
      const userId = await getUserId(ctx);
      return listCards(ctx, userId, {
        q: q.q,
        term: q.term,
        intent: q.intent,
        scope: q.scope,
        from: q.from,
        to: q.to,
        staleOnly: bool(q.stale),
        includeSkeleton: bool(q.include_skeleton),
        page: num(q.page, 1),
        pageSize: num(q.page_size, 20),
      });
    }),
  );

  app.get(
    '/api/cards/:id',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      return getCardDetail(ctx, userId, id);
    }),
  );

  app.patch(
    '/api/cards/:id',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const body = (req.body ?? {}) as Body;
      const result = await correct(ctx, {
        userId,
        target: { type: 'card', id },
        patch: body,
        reason: str(body.reason),
        actor: 'human',
      });
      await recordEvent(false);
      return result;
    }),
  );

  app.delete(
    '/api/cards/:id',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const q = req.query as Query;
      const mode = q.mode === 'purge' ? 'purge' : 'soft';
      return forget(ctx, {
        userId,
        target: { type: 'card', id },
        mode,
        confirm: bool(q.confirm) === true,
        reason: str(q.reason),
        actor: 'human',
      });
    }),
  );

  app.post(
    '/api/cards/:id/restore',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      await restoreSoft(ctx, userId, 'card', id, 'human');
      return { restored: id };
    }),
  );

  app.post(
    '/api/cards/:id/feedback',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const body = (req.body ?? {}) as Body;
      const verdict = str(body.verdict);
      if (verdict !== 'wrong' && verdict !== 'irrelevant' && verdict !== 'helpful') {
        throw new AppError('E_INVALID', 'verdict 只接受 wrong / irrelevant / helpful', {
          field: 'verdict',
          value: verdict,
        });
      }
      return feedback(ctx, {
        userId,
        cardId: id,
        verdict,
        note: str(body.note),
        actor: 'human',
      });
    }),
  );

  /* ---------------------------------------------------------- L1 块 */

  app.get(
    '/api/blocks',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      return listBlockDetails(ctx, userId);
    }),
  );

  app.put(
    '/api/blocks/:label',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const label = (req.params as { label: string }).label;
      const body = (req.body ?? {}) as Body;
      return correct(ctx, {
        userId,
        target: { type: 'block', label, slot: str(body.slot) ?? 'default' },
        patch: {
          content: String(body.content ?? ''),
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        },
        reason: str(body.reason),
        actor: 'human',
      });
    }),
  );

  app.delete(
    '/api/blocks/:id',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const q = req.query as Query;
      return forget(ctx, {
        userId,
        target: { type: 'block', id },
        mode: q.mode === 'purge' ? 'purge' : 'soft',
        confirm: bool(q.confirm) === true,
        reason: str(q.reason) ?? '撤销固化条目',
        actor: 'human',
      });
    }),
  );

  app.get(
    '/api/blocks/:label/versions',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const label = (req.params as { label: string }).label;
      const q = req.query as Query;
      const slot = str(q.slot) ?? 'default';
      const rows = await ctx.sql<Array<{ id: number }>>`
        SELECT id FROM mem_block WHERE user_id = ${userId} AND label = ${label} AND slot = ${slot} AND deleted_at IS NULL`;
      const id = Number(rows[0]?.id ?? 0);
      if (!id) throw new AppError('E_TARGET_NOT_FOUND', `块 ${label}/${slot} 不存在`);
      return listVersions(ctx, 'block', id);
    }),
  );

  /* ---------------------------------------------------------- 词与图谱 */

  app.get(
    '/api/terms',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const q = req.query as Query;
      return listTerms(ctx, userId, {
        q: q.q,
        kind: q.kind,
        page: num(q.page, 1),
        pageSize: num(q.page_size, 30),
      });
    }),
  );

  app.get(
    '/api/terms/suggest',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const q = req.query as Query;
      return termSuggestions(ctx, userId, q.q ?? '');
    }),
  );

  app.patch(
    '/api/terms/:id',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const body = (req.body ?? {}) as Body;
      return correct(ctx, {
        userId,
        target: { type: 'term', id },
        patch: body,
        reason: str(body.reason),
        actor: 'human',
      });
    }),
  );

  app.post(
    '/api/terms/:id/merge',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const body = (req.body ?? {}) as Body;
      const targetId = num(body.target_id, 0);
      if (!targetId) throw new AppError('E_INVALID', '需要 target_id');
      return mergeTerms(ctx, userId, id, targetId, 'human');
    }),
  );

  app.get(
    '/api/graph',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const q = req.query as Query;
      return graphData(ctx, userId, {
        focus: str(q.focus),
        depth: num(q.depth, 1),
        limit: num(q.limit, 200),
      });
    }),
  );

  // 径向全图：根 → 关键词 → 记忆卡片；关键词按出现卡数阈值与热度过滤
  app.get(
    '/api/graph/radial',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const q = req.query as Query;
      return graphRadial(ctx, userId, {
        minCards: num(q.min_cards, 3),
        heatTop: num(q.heat_top, 0),
      });
    }),
  );

  /* ---------------------------------------------------------- 召回与下钻（Web 预览） */

  app.get(
    '/api/start/preview',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      return startPreview(ctx, userId);
    }),
  );

  app.post(
    '/api/recall',
    wrap(async (req) => {
      await guard(req);
      const body = (req.body ?? {}) as Body;
      const started = Date.now();
      const result = await recall(ctx, {
        query: String(body.query ?? ''),
        scope: (body.scope as 'all' | 'project' | 'person') ?? 'all',
        budgetTokens: optionalNum(body.budget_tokens),
        includeWeak: bool(body.include_weak),
        debug: body.debug === true,
        actor: 'human',
      });
      recordRecall({
        budgetUsed: result.budget_used,
        budgetLimit: result.budget_limit,
        hitCards: result.cards.length,
        dropped: result.dropped.length,
        latencyMs: Date.now() - started,
      });
      return result;
    }),
  );

  app.post(
    '/api/expand',
    wrap(async (req) => {
      await guard(req);
      const body = (req.body ?? {}) as Body;
      return expand(ctx, {
        cardId: optionalNum(body.card_id),
        term: (body.term as string | number | undefined) ?? undefined,
        depth: optionalNum(body.depth),
        limit: optionalNum(body.limit),
        actor: 'human',
      });
    }),
  );

  app.post(
    '/api/write',
    wrap(async (req) => {
      await guard(req);
      const body = (req.body ?? {}) as Body;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length === 0) throw new AppError('E_INVALID', 'messages 不能为空');
      const result = await write(ctx, {
        messages: messages as Array<{ role: string; content: string; tool_name?: string; ts?: string }>,
        scope: str(body.scope),
        event_id: optionalNum(body.event_id),
        close: bool(body.close),
        source: body.source === 'external' ? 'external' : 'user',
        actor: 'human',
        card: (body.card ?? undefined) as CardOverrides | undefined,
        append_to: optionalNum(body.append_to),
        dedupe: body.dedupe === true ? true : undefined,
        summary_mode: body.summary_mode === 'replace' ? 'replace' : undefined,
      });
      await recordEvent(!result.card_pending, false, result.appended === true);
      return result;
    }),
  );

  app.post(
    '/api/condense',
    wrap(async (req) => {
      await guard(req);
      const body = (req.body ?? {}) as Body;
      const eventId = num(body.event_id, 0);
      const userId = await getUserId(ctx);
      const { condenseEvent } = await import('../services/memory.service.js');
      const result = await condenseEvent(ctx, userId, eventId, {
        actor: 'human',
        card: (body.card ?? undefined) as CardOverrides | undefined,
        appendTo: optionalNum(body.append_to),
        dedupe: body.dedupe === true ? true : undefined,
      });
      await recordEvent(true, false, result.appended);
      return result;
    }),
  );

  /* ---------------------------------------------------------- 待审队列 */

  app.get(
    '/api/candidates',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const q = req.query as Query;
      return listCandidates(ctx, userId, str(q.status) ?? 'pending');
    }),
  );

  app.post(
    '/api/candidates/:id/approve',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      return approveCandidate(ctx, userId, id, 'human');
    }),
  );

  app.post(
    '/api/candidates/:id/reject',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      const body = (req.body ?? {}) as Body;
      await rejectCandidate(ctx, userId, id, str(body.reason), 'human');
      return { rejected: id };
    }),
  );

  /* ---------------------------------------------------------- 审计 / 版本 / 回收站 */

  app.get(
    '/api/audit',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const q = req.query as Query;
      return listAudit(ctx, userId, {
        objectType: str(q.object_type),
        objectId: optionalNum(q.object_id),
        limit: num(q.limit, 100),
      });
    }),
  );

  app.get(
    '/api/versions/:objectType/:objectId',
    wrap(async (req) => {
      await guard(req);
      const params = req.params as { objectType: string; objectId: string };
      return listVersions(ctx, params.objectType, num(params.objectId, 0));
    }),
  );

  app.get(
    '/api/trash',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      return listTrash(ctx, userId);
    }),
  );

  app.post(
    '/api/trash/:id/restore',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const id = num((req.params as { id: string }).id, 0);
      await restoreSnapshot(ctx, userId, id, 'human');
      return { restored: id };
    }),
  );

  app.post(
    '/api/trash/soft/:type/:id/restore',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      const params = req.params as { type: string; id: string };
      await restoreSoft(ctx, userId, params.type, num(params.id, 0), 'human');
      return { restored: num(params.id, 0) };
    }),
  );

  /* ---------------------------------------------------------- 巡检 */

  app.post(
    '/api/admin/patrol',
    wrap(async (req) => {
      await guard(req);
      const userId = await getUserId(ctx);
      return runPatrol(ctx, userId);
    }),
  );
}
