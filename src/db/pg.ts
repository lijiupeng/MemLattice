import postgres from 'postgres';
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

/** bigint 统一解析为 number（单库单用户的 id 规模远小于 2^53）。 */
const int8AsNumber: postgres.PostgresType<number> = {
  to: 20,
  from: [20],
  serialize: (value: number) => String(value),
  parse: (raw: unknown) => Number(raw),
};

export function createPgSql(url: string, max = 10): Sql {
  const client = postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    types: { bigint: int8AsNumber },
  });

  const run = (<T>(strings: TemplateStringsArray, ...params: unknown[]): Promise<T> => {
    const { text, values } = compile(strings, params, 'pg');
    const pending = client.unsafe(text, values as never[]) as unknown as Promise<T>;
    // 报错时把语句带出来：双后端下没有上下文根本定位不到是哪条 SQL
    return pending.catch((err: unknown) => {
      if (err instanceof Error) {
        const oneLine = text.replace(/\s+/g, ' ').trim().slice(0, 300);
        err.message = `${err.message} | SQL: ${oneLine}`;
      }
      throw err;
    });
  }) as Sql;

  Object.defineProperty(run, 'dialect', { value: 'pg', enumerable: true });

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

  run.unsafe = async (text: string): Promise<unknown> => client.unsafe(text);

  run.end = async (opts?: { timeout?: number }): Promise<void> => {
    await client.end({ timeout: opts?.timeout ?? 5 });
  };

  return run;
}
