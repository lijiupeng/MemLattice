import type { AppConfig } from '../config.js';
import type { FragmentParam, Sql } from '../db/client.js';
import { ensureUser } from '../db/bootstrap.js';
import type { Tokenizer } from '../core/tokenizer.js';
import { projectHeat } from '../core/heat.js';

export type Actor = 'agent' | 'human' | 'system';

/** postgres.js 的 array() 第二参是类型 OID，不是类型名。 */
export const OID = { int8: 20, text: 25, float4: 700 } as const;

export interface Ctx {
  sql: Sql;
  cfg: AppConfig;
  tokenizer: Tokenizer;
  now: () => Date;
  /** 单用户部署下缓存一次即可（D1：保留 user_id，首版只建一行） */
  cachedUserId?: number;
}

export async function getUserId(ctx: Ctx): Promise<number> {
  if (ctx.cachedUserId !== undefined) return ctx.cachedUserId;
  const id = await ensureUser(ctx.sql, ctx.cfg);
  ctx.cachedUserId = id;
  return id;
}

export interface AuditInput {
  userId?: number;
  objectType: 'card' | 'block' | 'term' | 'raw' | 'candidate' | 'trash' | 'lifecycle' | 'setting';
  objectId: number;
  op: string;
  before?: unknown;
  after?: unknown;
  actor: Actor;
  reason?: string;
}

/** FR-13：所有修改记录操作者、时间、变更前后内容与原因。 */
export async function writeAudit(ctx: Ctx, input: AuditInput): Promise<number> {
  const rows = await ctx.sql<{ id: number }[]>`
    INSERT INTO mem_audit (user_id, object_type, object_id, op, before, after, actor, reason)
    VALUES (
      ${input.userId ?? null},
      ${input.objectType},
      ${input.objectId},
      ${input.op},
      ${input.before === undefined ? null : ctx.sql.json(input.before as never)},
      ${input.after === undefined ? null : ctx.sql.json(input.after as never)},
      ${input.actor},
      ${input.reason ?? null}
    )
    RETURNING id`;
  return Number(rows[0]?.id ?? 0);
}

export async function saveVersion(
  ctx: Ctx,
  input: {
    objectType: 'card' | 'block';
    objectId: number;
    version: number;
    snapshot: unknown;
    actor: Actor;
  },
): Promise<void> {
  await ctx.sql`
    INSERT INTO mem_version (object_type, object_id, version, snapshot, actor)
    VALUES (${input.objectType}, ${input.objectId}, ${input.version}, ${ctx.sql.json(
      input.snapshot as never,
    )}, ${input.actor})
    ON CONFLICT (object_type, object_id, version) DO NOTHING`;
}

/** 直接以负数入参，避免 SQL 里出现一元负号作用在 unknown 参数上（PG 无法推断类型）。 */
const NEG_LN2 = -Math.log(2);

/**
 * heat_at 到 now 相差的天数：PG 用 EPOCH 差值换算，SQLite 用 julianday 差值，
 * 两者都以「天」为单位，半衰期公式因此在两端语义一致。
 */
function elapsedDays(ctx: Ctx, now: Date): FragmentParam {
  return ctx.sql.dialect === 'pg'
    ? ctx.sql.fragment`(EXTRACT(EPOCH FROM (${now}::timestamptz - heat_at)) / 86400.0)`
    : ctx.sql.fragment`(julianday(${now}) - julianday(heat_at))`;
}

/** term 热度增量更新（FR-14）：命中 +1.0、下钻 +1.5、被新卡引用 +2.0。 */
export async function touchTermHeat(
  ctx: Ctx,
  ids: readonly number[],
  delta: number,
  markHit = true,
): Promise<void> {
  if (ids.length === 0 || delta === 0) return;
  const now = ctx.now();
  const hl = ctx.cfg.life.termHalfLifeDays;
  // exp 恒为正、heat 非负、delta 为正，结果不可能为负，因此不再做下限截断
  await ctx.sql`
    UPDATE term
    SET heat = heat * exp(${NEG_LN2} * ${elapsedDays(ctx, now)} / ${hl}) + ${delta},
        heat_at = ${now},
        last_hit_at = ${markHit ? now : ctx.sql.raw('last_hit_at')}
    WHERE id IN (${[...ids]}) AND deleted_at IS NULL`;
}

/** 卡被采用（expand 读了、append 用上了）：热度、采用计数、最近命中一起更新。 */
export async function touchCardHeat(
  ctx: Ctx,
  ids: readonly number[],
  delta: number,
): Promise<void> {
  if (ids.length === 0 || delta === 0) return;
  const now = ctx.now();
  const hl = ctx.cfg.life.cardHalfLifeDays;
  await ctx.sql`
    UPDATE mem_card
    SET heat = heat * exp(${NEG_LN2} * ${elapsedDays(ctx, now)} / ${hl}) + ${delta},
        heat_at = ${now},
        use_count = use_count + 1,
        last_used_at = ${now},
        last_hit_at = ${now}
    WHERE id IN (${[...ids]})`;
}

/**
 * 卡只是被拉进上下文（recall 命中）：只记曝光，不涨热度、不计采用。
 * 曝光与采用分开，才能算出"总被拉出来但没人用"的噪声卡。
 */
export async function recordCardHit(ctx: Ctx, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await ctx.sql`
    UPDATE mem_card
    SET hit_count = hit_count + 1,
        last_hit_at = ${ctx.now()}
    WHERE id IN (${[...ids]})`;
}

/**
 * 经验块的两种"被用到"：
 * - 默认（看到索引）：只刷新 last_used_at，不计数、不涨热度；
 * - call=true（真的按 id 取了正文）：use_count +1 并累加热度，供"常用经验前 N 条"排序。
 */
export async function touchBlockUsed(
  ctx: Ctx,
  ids: readonly number[],
  call?: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  if (!call) {
    await ctx.sql`
      UPDATE mem_block SET last_used_at = ${ctx.now()}
      WHERE id IN (${[...ids]})`;
    return;
  }
  const now = ctx.now();
  const hl = ctx.cfg.life.termHalfLifeDays;
  await ctx.sql`
    UPDATE mem_block
    SET heat = heat * exp(${NEG_LN2} * ${elapsedDays(ctx, now)} / ${hl}) + 1.0,
        heat_at = ${now},
        use_count = use_count + 1,
        last_used_at = ${now}
    WHERE id IN (${[...ids]})`;
}

export interface HeatRow {
  heat: number;
  heat_at: Date;
  last_hit_at?: Date | null;
  created_at?: Date;
}

export function heatNow(ctx: Ctx, row: HeatRow, halfLifeDays: number): number {
  return projectHeat(Number(row.heat), new Date(row.heat_at), halfLifeDays, ctx.now());
}
