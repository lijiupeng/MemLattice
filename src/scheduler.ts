import { readLastPatrol, runPatrol } from './services/lifecycle.service.js';
import type { Ctx } from './services/context.js';

/** 超过这个间隔还没跑过，就认为本机错过了定时点 */
const CATCHUP_AFTER_MS = 24 * 3_600_000;

/**
 * 启动补跑：定时器是「等到下一个 hour 点」的 setTimeout，
 * 本机那一刻没开机就永远不会触发，所以在启动时先看上次跑了多久前。
 */
export async function runPatrolIfStale(
  ctx: Ctx,
  userId: number,
  log: (message: string, err?: unknown) => void,
): Promise<void> {
  if (!ctx.cfg.worker.enabled) return;
  const last = await readLastPatrol(ctx, userId);
  const now = ctx.now();
  if (last && now.getTime() - last.getTime() < CATCHUP_AFTER_MS) return;
  log(
    last
      ? `距上次巡检 ${Math.round((now.getTime() - last.getTime()) / 3_600_000)} 小时，启动补跑一次`
      : '没有巡检记录，启动先跑一次',
  );
  try {
    await runPatrol(ctx, userId);
  } catch (err) {
    log('启动补跑失败', err);
  }
}

/** 计算距下一次 hour 点的毫秒数（本地时区）。 */
export function delayUntilHour(hour: number, now: Date = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startPatrolScheduler(
  ctx: Ctx,
  userId: number,
  log: (message: string, err?: unknown) => void,
): () => void {
  if (!ctx.cfg.worker.enabled) {
    log('巡检调度已关闭（WORKER_ENABLED=false）');
    return () => {};
  }
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    const delay = delayUntilHour(ctx.cfg.worker.hour);
    timer = setTimeout(() => {
      void (async () => {
        try {
          const report = await runPatrol(ctx, userId);
          log(
            `巡检完成：淘汰 ${report.evicted}，降级 ${report.demotion}，待淡忘 ${report.decay_candidates}，耗时 ${report.duration_ms}ms`,
          );
        } catch (err) {
          log('巡检失败', err);
        } finally {
          scheduleNext();
        }
      })();
    }, delay);
    timer.unref?.();
  };

  scheduleNext();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
