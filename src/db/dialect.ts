/**
 * 双后端的最小公共面：调用点仍然写 sql`... ${value} ...`，由各驱动编译成自己的占位符。
 * 需要拼接 SQL 片段时必须走 raw / assign，不允许把 sql`` 嵌进另一个模板里——
 * 那在 PG 里是片段、在 SQLite 里会变成一个待绑定的 Promise。
 */

export type Dialect = 'pg' | 'sqlite';

/** 作为单个值绑定（PG 数组 / SQLite JSON 文本）；与在 IN (...) 里展开的普通数组区分。 */
export interface ArrayParam {
  readonly __array: readonly unknown[];
  readonly __oid?: number;
}

/** 原样拼进 SQL 的常量片段（列名、固定子句），不得来自外部输入。 */
export interface RawParam {
  readonly __raw: string;
}

/**
 * 结构化值：PG 侧交原始对象给驱动自行编码（传字符串会被二次编码成 JSON 字符串标量），
 * SQLite 侧落 JSON 文本。
 */
export interface JsonParam {
  readonly __value: unknown;
}

/** 动态 SET 子句：col = 值, col2 = 值。 */
export interface AssignParam {
  readonly __assign: {
    readonly patch: Record<string, unknown>;
    readonly keys: readonly string[];
  };
}

/** 多行 VALUES：((列数一致的参数组矩阵)) → ($1,$2), ($3,$4)。 */
export interface ValuesParam {
  readonly __values: readonly (readonly unknown[])[];
}

/**
 * 可嵌套片段：把带参数的条件先攒起来，等插入最终语句时统一编号。
 * 直接写 `${ctx.sql`...`}` 在 PG 里是片段，在这里会变成待绑定的 Promise，必须走这个入口。
 */
export interface FragmentParam {
  readonly __fragment: {
    readonly strings: TemplateStringsArray;
    readonly params: readonly unknown[];
  };
}

export interface Sql {
  readonly dialect: Dialect;
  <T = any>(strings: TemplateStringsArray, ...params: unknown[]): Promise<T>;
  array(values: readonly (string | number)[], oid?: number): ArrayParam;
  /** 结构化值绑定到 jsonb / JSON 文本列；PG 侧会补 ::jsonb，否则读回来是字符串。 */
  json(value: unknown): JsonParam;
  raw(text: string): RawParam;
  assign(patch: Record<string, unknown>, keys: readonly string[]): AssignParam;
  values(rows: readonly (readonly unknown[])[]): ValuesParam;
  fragment(strings: TemplateStringsArray, ...params: unknown[]): FragmentParam;
  /** 整段 SQL 文本（迁移脚本、巡检里的动态 DDL），不做参数化 */
  unsafe(text: string): Promise<unknown>;
  end(opts?: { timeout?: number }): Promise<void>;
}

export function isArrayParam(value: unknown): value is ArrayParam {
  return typeof value === 'object' && value !== null && Array.isArray((value as ArrayParam).__array);
}

export function isRawParam(value: unknown): value is RawParam {
  return typeof value === 'object' && value !== null && typeof (value as RawParam).__raw === 'string';
}

export function isJsonParam(value: unknown): value is JsonParam {
  return typeof value === 'object' && value !== null && '__value' in (value as JsonParam);
}

export function isAssignParam(value: unknown): value is AssignParam {
  return typeof value === 'object' && value !== null && (value as AssignParam).__assign !== undefined;
}

export function isValuesParam(value: unknown): value is ValuesParam {
  return typeof value === 'object' && value !== null && Array.isArray((value as ValuesParam).__values);
}

export function isFragmentParam(value: unknown): value is FragmentParam {
  return (
    typeof value === 'object' && value !== null && (value as FragmentParam).__fragment !== undefined
  );
}

function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'pg' ? `$${index}` : '?';
}

/** postgres.js 的 OID 常量 → 类型名；数组参数要落成显式 ARRAY[...]::type 才能被 ANY 与数组列接受。 */
const OID_TYPE: Record<number, string> = {
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
};

function pgArrayType(oid: number | undefined): string {
  return OID_TYPE[oid ?? 25] ?? 'text';
}

/** SQLite 只接受 number / string / bigint / Buffer / null，日期与布尔要在这里落成可存储的形态。 */
function normalize(value: unknown, dialect: Dialect): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return dialect === 'sqlite' ? value.toISOString() : value;
  if (typeof value === 'boolean') return dialect === 'sqlite' ? (value ? 1 : 0) : value;
  return value;
}

/** 数组作为「一个值」绑定：PG 走 ARRAY[...]::type，SQLite 存 JSON 文本。 */
function bindArray(
  values: readonly unknown[],
  oid: number | undefined,
  dialect: Dialect,
  out: unknown[],
): string {
  if (dialect === 'sqlite') {
    out.push(JSON.stringify(values));
    return placeholder(dialect, out.length);
  }
  const type = pgArrayType(oid);
  if (values.length === 0) return `ARRAY[]::${type}[]`;
  const marks = values.map((item) => {
    out.push(normalize(item, dialect));
    return placeholder(dialect, out.length);
  });
  return `ARRAY[${marks.join(', ')}]::${type}[]`;
}

/** 标量绑定。 */
function bindScalar(value: unknown, dialect: Dialect, out: unknown[]): string {
  out.push(normalize(value, dialect));
  return placeholder(dialect, out.length);
}

export interface Compiled {
  text: string;
  values: unknown[];
}

function renderParam(value: unknown, dialect: Dialect, out: unknown[]): string {
  if (isRawParam(value)) return value.__raw;

  if (isJsonParam(value)) {
    out.push(dialect === 'sqlite' ? JSON.stringify(value.__value) : value.__value);
    return placeholder(dialect, out.length);
  }

  if (isFragmentParam(value)) {
    return render(value.__fragment.strings, value.__fragment.params, dialect, out);
  }

  if (isValuesParam(value)) {
    if (value.__values.length === 0) return '(NULL)';
    return value.__values
      .map((row) => `(${row.map((item) => bindScalar(item, dialect, out)).join(', ')})`)
      .join(', ');
  }

  if (isAssignParam(value)) {
    const { patch, keys } = value.__assign;
    return keys
      .map((column) => {
        const patchValue = patch[column];
        // 列本身是数组（keywords / entities / aliases）时按数组值绑定，不做 IN 展开
        if (Array.isArray(patchValue)) {
          return `${column} = ${bindArray(patchValue, undefined, dialect, out)}`;
        }
        return `${column} = ${bindScalar(patchValue, dialect, out)}`;
      })
      .join(', ');
  }

  if (Array.isArray(value)) {
    // 普通数组 = IN 列表：空列表直接落 NULL，避免生成 IN () 语法错误
    if (value.length === 0) return 'NULL';
    return value.map((item) => bindScalar(item, dialect, out)).join(', ');
  }

  if (isArrayParam(value)) return bindArray(value.__array, value.__oid, dialect, out);

  return bindScalar(value, dialect, out);
}

function render(
  strings: readonly string[],
  params: readonly unknown[],
  dialect: Dialect,
  out: unknown[],
): string {
  let text = '';
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i];
    if (i >= params.length) break;
    text += renderParam(params[i], dialect, out);
  }
  return text;
}

export function compile(
  strings: TemplateStringsArray,
  params: readonly unknown[],
  dialect: Dialect,
): Compiled {
  const values: unknown[] = [];
  const text = render(strings, params, dialect, values);
  return { text, values };
}
