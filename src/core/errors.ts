export type ErrorCode =
  | 'E_AUTH'
  | 'E_ORIGIN'
  | 'E_BLOCK_LIMIT'
  | 'E_BUDGET_EXCEEDED'
  | 'E_TARGET_NOT_FOUND'
  | 'E_IMMUTABLE_RAW'
  | 'E_NOT_APPROVED'
  | 'E_INVALID'
  | 'E_CONFLICT'
  | 'E_RECALL_REQUIRED'
  | 'E_INTERNAL';

const HTTP_STATUS: Record<ErrorCode, number> = {
  E_AUTH: 401,
  E_ORIGIN: 403,
  E_BLOCK_LIMIT: 422,
  E_BUDGET_EXCEEDED: 422,
  E_TARGET_NOT_FOUND: 404,
  E_IMMUTABLE_RAW: 409,
  E_NOT_APPROVED: 403,
  E_INVALID: 400,
  E_CONFLICT: 409,
  E_RECALL_REQUIRED: 409,
  E_INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = HTTP_STATUS[code] ?? 500;
    this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toErrorPayload(e: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: unknown } };
} {
  if (isAppError(e)) {
    return { status: e.status, body: e.toJSON() };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { status: 500, body: { error: { code: 'E_INTERNAL', message } } };
}
