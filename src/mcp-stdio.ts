import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { closeSql, createSql } from './db/client.js';
import { bootstrap } from './db/bootstrap.js';
import { migrateUp } from './db/migrate.js';
import { createTokenizer } from './core/tokenizer.js';
import { buildMcpServer } from './api/mcp.js';
import type { Ctx } from './services/context.js';
import { loadSettings } from './services/settings.service.js';

/**
 * stdio 基本只被 DSH 这类桌面客户端使用，它们没有 CodeBuddy 那套会话钩子。
 * 默认关掉自检，否则模型会拿着一个本机不存在的路径去查、甚至去装。
 * 需要自检的客户端显式设 HOOK_CHECK=on 即可。
 */
process.env.HOOK_CHECK ??= 'off';

/** stdio 传输：桌面客户端普遍只支持 stdio（1.2 取舍）。注意 stdout 只能走协议数据。 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const sql = createSql(cfg);
  const tokenizer = await createTokenizer();

  if (process.env.RUN_MIGRATIONS !== 'false') {
    await migrateUp(sql, cfg.migrationsDir, (msg) => console.error(`[migrate] ${msg}`));
  }
  const userId = await bootstrap(sql, cfg);

  const ctx: Ctx = {
    sql,
    cfg,
    tokenizer,
    now: () => new Date(),
    cachedUserId: userId,
  };

  await loadSettings(ctx);

  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[memlattice] stdio MCP 已启动（分词：${tokenizer.name}，关键词由调用方传入）`);

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      await closeSql(sql);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
