import { loadConfig } from './config.js';
import { closeSql, createSql } from './db/client.js';
import { bootstrap } from './db/bootstrap.js';
import { migrateUp } from './db/migrate.js';
import { createTokenizer } from './core/tokenizer.js';
import { runPatrol } from './services/lifecycle.service.js';
import { runPatrolIfStale, startPatrolScheduler } from './scheduler.js';
import type { Ctx } from './services/context.js';
import { loadSettings } from './services/settings.service.js';

/** 独立 Worker 进程：同一业务层，可与主服务分机部署（2. 总体架构）。 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const sql = createSql(cfg);
  const tokenizer = await createTokenizer();

  if (process.env.RUN_MIGRATIONS !== 'false') {
    await migrateUp(sql, cfg.migrationsDir, (msg) => console.log(`[migrate] ${msg}`));
  }
  const userId = await bootstrap(sql, cfg);
  const ctx: Ctx = { sql, cfg, tokenizer, now: () => new Date(), cachedUserId: userId };

  await loadSettings(ctx);

  const once = process.argv.includes('--once');
  if (once) {
    const report = await runPatrol(ctx, userId);
    console.log(JSON.stringify(report, null, 2));
    await closeSql(sql);
    return;
  }

  const stop = startPatrolScheduler(ctx, userId, (message, err) => {
    if (err) console.error(message, err);
    else console.log(message);
  });
  console.log(`MemLattice Worker 已启动，每日 ${cfg.worker.hour}:00 执行巡检`);

  // 本机错过定时点时补跑一次
  void runPatrolIfStale(ctx, userId, (message, err) => {
    if (err) console.error(message, err);
    else console.log(message);
  });

  const shutdown = async (): Promise<void> => {
    stop();
    await closeSql(sql);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
