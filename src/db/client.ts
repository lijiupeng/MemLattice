import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Dialect, Sql } from './dialect.js';
import { createPgSql } from './pg.js';
import { createSqliteSql } from './sqlite.js';

export type {
  ArrayParam,
  AssignParam,
  Dialect,
  FragmentParam,
  JsonParam,
  RawParam,
  Sql,
  ValuesParam,
} from './dialect.js';
export { isArrayParam } from './dialect.js';

export interface DbConfig {
  dbDialect: Dialect;
  databaseUrl: string;
  dbMaxConnections: number;
  sqlitePath: string;
}

export function createSql(cfg: DbConfig): Sql {
  if (cfg.dbDialect === 'sqlite') {
    const path = cfg.sqlitePath;
    if (!path.startsWith(':')) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    return createSqliteSql(path);
  }
  return createPgSql(cfg.databaseUrl, cfg.dbMaxConnections);
}

export async function closeSql(sql: Sql): Promise<void> {
  await sql.end({ timeout: 5 });
}
