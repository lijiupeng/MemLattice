import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { closeSql, createSql } from './db/client.js';
import { bootstrap } from './db/bootstrap.js';
import { migrateUp } from './db/migrate.js';
import { createTokenizer } from './core/tokenizer.js';
import { registerRest } from './api/rest.js';
import { registerMcpHttp } from './api/mcp.js';
import { runPatrolIfStale, startPatrolScheduler } from './scheduler.js';
import type { Ctx } from './services/context.js';
import { loadSettings } from './services/settings.service.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const sql = createSql(cfg);
  const tokenizer = await createTokenizer();

  let logFileStream: ReturnType<typeof createWriteStream> | null = null;
  if (cfg.logFile) {
    mkdirSync(dirname(cfg.logFile), { recursive: true });
    logFileStream = createWriteStream(cfg.logFile, { flags: 'a' });
  }
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      ...(logFileStream
        ? {
            stream: {
              write: (line: string) => {
                process.stdout.write(line);
                logFileStream.write(line);
              },
            },
          }
        : {}),
    },
    bodyLimit: 8 * 1024 * 1024,
  });

  // 请求日志由 Fastify 内置输出（含 responseTime）；这里只补慢请求告警（NFR-07）
  app.addHook('onResponse', async (req, reply) => {
    const elapsed = Math.round(reply.elapsedTime);
    if (elapsed > 1000) {
      req.log.warn(
        { method: req.method, url: req.url, status: reply.statusCode, elapsed_ms: elapsed, slow: true },
        'slow request',
      );
    }
  });

  // 宽松 JSON 解析：允许 DELETE / 无 body 的 POST 带 content-type: application/json
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : String(body ?? '');
    if (text.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('请求体不是合法的 JSON') as Error & { statusCode?: number; code?: string };
      err.statusCode = 400;
      err.code = 'FST_ERR_CTP_INVALID_JSON_BODY';
      done(err, undefined);
    }
  });

  if (process.env.RUN_MIGRATIONS !== 'false') {
    const applied = await migrateUp(sql, cfg.migrationsDir, (msg) => app.log.info(msg));
    if (applied.length > 0) app.log.info({ applied }, '数据库迁移已应用');
  }
  const userId = await bootstrap(sql, cfg);

  const ctx: Ctx = {
    sql,
    cfg,
    tokenizer,
    now: () => new Date(),
    cachedUserId: userId,
  };

  const overridden = await loadSettings(ctx);
  if (overridden.length > 0) {
    app.log.info({ count: overridden.length }, '已应用页面保存的运行时参数');
  }

  registerRest(app, ctx);
  registerMcpHttp(app, ctx);

  if (existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir, prefix: '/', wildcard: false });
    app.log.info({ webDir: cfg.webDir }, '静态资源已挂载');
  } else {
    app.get('/', async (_req, reply) => {
      await reply
        .type('text/plain; charset=utf-8')
        .send('MemLattice API 已启动。前端产物缺失，请先执行 npm run web:build。');
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const isApi = req.url.startsWith('/api') || req.url.startsWith('/mcp');
    const indexFile = join(cfg.webDir, 'index.html');
    if (!isApi && req.method === 'GET' && existsSync(indexFile)) {
      return reply.type('text/html; charset=utf-8').send(readFileSync(indexFile, 'utf8'));
    }
    return reply.code(404).send({ error: { code: 'E_TARGET_NOT_FOUND', message: 'Not Found' } });
  });

  const stopScheduler = startPatrolScheduler(ctx, userId, (message, err) => {
    if (err) app.log.error({ err }, message);
    else app.log.info(message);
  });

  await app.listen({ port: cfg.port, host: cfg.host });
  app.log.info(
    {
      port: cfg.port,
      tokenizer: tokenizer.name,
      mcp: `http://localhost:${cfg.port}/mcp`,
    },
    'MemLattice 已启动',
  );

  // 本地部署常常错过定时点，开机先补一次；异步跑，不挡对外服务
  void runPatrolIfStale(ctx, userId, (message, err) => {
    if (err) app.log.error({ err }, message);
    else app.log.info(message);
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '正在关闭');
    stopScheduler();
    try {
      await app.close();
    } finally {
      await closeSql(sql);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
