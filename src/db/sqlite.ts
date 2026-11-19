import Database from 'better-sqlite3';
import {
  compile,
  type ArrayParam,
  type AssignParam,
  type FragmentParam,
  type JsonParam,
  type RawParam,
  type ValuesParam,
  type Sql,
} from './dialect.js';

/**
 * 这些列在 PG 里是 jsonb / text[]，SQLite 侧统一存 JSON 文本。
 * 读取时按列名还原，避免调用点各自判断类型。
 */
const JSON_COLUMNS = new Set([
  'aliases',
  'keywords',
  'entities',
  'ref_terms',
  'ref_cards',
  'payload',
  'evidence',
  'before',
  'after',
  'snapshot',
  'blocks',
  'cards',
  'hints',
  'dropped',
]);

/** 语句缓存上限：Sql 文本种类有限，超了就整体丢弃重建，避免无界增长。 */
const STATEMENT_CACHE_LIMIT = 300;

function reviveRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value === 'bigint') {
      row[key] = Number(value);
      continue;
    }
    if (typeof value !== 'string' || !JSON_COLUMNS.has(key)) continue;
    const head = value.trimStart()[0];
    if (head !== '[' && head !== '{') continue;
    try {
      row[key] = JSON.parse(value) as unknown;
    } catch {
      // 不是合法 JSON 就保留原文，宁可让上层看到字符串也不要吞掉内容
    }
  }
  return row;
}

export function createSqliteSql(path: string): Sql {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  let cache = new Map<string, Database.Statement>();

  const statement = (text: string): Database.Statement => {
    let stmt = cache.get(text);
    if (stmt) return stmt;
    if (cache.size >= STATEMENT_CACHE_LIMIT) cache = new Map();
    stmt = db.prepare(text);
    cache.set(text, stmt);
    return stmt;
  };

  const run = (<T>(strings: TemplateStringsArray, ...params: unknown[]): Promise<T> => {
    const { text, values } = compile(strings, params, 'sqlite');
    try {
      const stmt = statement(text);
      if (stmt.reader) {
        const rows = stmt.all(...values) as Array<Record<string, unknown>>;
        return Promise.resolve(rows.map(reviveRow) as unknown as T);
      }
      stmt.run(...values);
      return Promise.resolve([] as unknown as T);
    } catch (err) {
      // 双后端下没有语句上下文基本无法定位问题
      if (err instanceof Error) {
        err.message = `${err.message} | SQL: ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
      }
      throw err;
    }
  }) as Sql;

  Object.defineProperty(run, 'dialect', { value: 'sqlite', enumerable: true });

  run.array = (values: readonly (string | number)[], oid?: number): ArrayParam => ({
    __array: values,
    ...(oid === undefined ? {} : { __oid: oid }),
  });

  run.json = (value: unknown): JsonParam => ({ __value: value });

  run.raw = (text: string): RawParam => ({ __raw: text });

  run.assign = (patch: Record<string, unknown>, keys: readonly string[]): AssignParam => ({
    __assign: { patch, keys },
  });

  run.values = (rows: readonly (readonly unknown[])[]): ValuesParam => ({ __values: rows });

  run.fragment = (strings: TemplateStringsArray, ...params: unknown[]): FragmentParam => ({
    __fragment: { strings, params },
  });

  run.unsafe = async (text: string): Promise<unknown> => {
    db.exec(text);
    cache = new Map();
    return undefined;
  };

  run.end = async (): Promise<void> => {
    cache = new Map();
    db.close();
  };

  return run;
}
