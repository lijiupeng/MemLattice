import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, toErrorPayload } from '../core/errors.js';
import type { AppConfig } from '../config.js';

export type Body = Record<string, unknown>;
export type Query = Record<string, string | undefined>;

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** NFR-04：校验 Origin 白名单，默认只允许同源与 localhost，关闭通配 CORS。 */
export function originAllowed(origin: string | undefined, cfg: AppConfig, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (cfg.allowedOrigins.includes(origin)) return true;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') return true;
    if (host && url.host === host) return true;
    return false;
  } catch {
    return false;
  }
}

export function assertAuthorized(req: FastifyRequest, cfg: AppConfig): void {
  const token = bearerToken(req.headers.authorization) ?? (req.query as Query | undefined)?.token;
  if (!token || token !== cfg.authToken) {
    throw new AppError('E_AUTH', '缺少或错误的访问令牌');
  }
}

export function assertOrigin(req: FastifyRequest, cfg: AppConfig): void {
  if (!originAllowed(req.headers.origin, cfg, req.headers.host)) {
    throw new AppError('E_ORIGIN', `来源 ${req.headers.origin} 不在白名单内`);
  }
}

export function wrap<T>(
  fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T>,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    try {
      const result = await fn(req, reply);
      if (result !== undefined && !reply.sent) await reply.send(result);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      // 5xx 带堆栈写日志，4xx 记录错误码，便于排查（NFR-07）
      if (status >= 500) {
        req.log.error({ err, method: req.method, url: req.url }, 'request failed');
      } else {
        req.log.warn(
          { code: body.error.code, message: body.error.message, method: req.method, url: req.url },
          'request rejected',
        );
      }
      if (!reply.sent) {
        await reply.code(status).type('application/json').send(body);
      }
    }
  };
}

export function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function optionalNum(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}
