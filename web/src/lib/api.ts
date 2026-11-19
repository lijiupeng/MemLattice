const TOKEN_KEY = 'memlattice.token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  // 只有带 body 时才声明 JSON，避免 DELETE/无参 POST 触发 "empty json body" 400
  if (init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || '请求失败';
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code, `${message} [${code}]`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/* ------------------------------------------------------------------ types */

export interface BlockItem {
  id: number;
  label: 'persona' | 'rules' | 'skills';
  slot: string;
  /** 技能的一句话描述（只有它进 L1 索引）；其它块为 null */
  summary: string | null;
  /** 技能被按 id 取用的次数 */
  use_count: number;
  content: string;
  char_limit: number;
  read_only: boolean;
  source: string;
  heat: number;
  version: number;
  ref_terms: number[];
  ref_cards: number[];
  updated_at: string;
  tokens: number;
}

export interface CardListItem {
  id: number;
  event_id: number;
  summary: string;
  intent: string | null;
  keywords: string[];
  entities: string[];
  importance: number;
  heat: number;
  status: string;
  source: string;
  category: string;
  version: number;
  is_skeleton: boolean;
  stale: boolean;
  created_at: string;
  raw_count: number;
  confidence: number;
  use_count: number;
  hit_count: number;
}

export interface CardListResponse {
  items: CardListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CardDetailResponse {
  card: Record<string, unknown> & {
    id: number;
    summary: string;
    intent: string | null;
    keywords: string[];
    entities: string[];
    importance: number;
    heat: number;
    version: number;
    is_skeleton: boolean;
    stale_at: string | null;
    created_at: string;
    category: string;
    source: string;
  };
  terms: Array<{ id: number; name: string; kind: string; role: string; weight: number }>;
  raw_refs: Array<{
    raw_id: number;
    seq: number;
    role: string;
    content: string;
    ts: string;
    archived: boolean;
    event_id: number;
    event_started_at: string | null;
    session_id: string | null;
  }>;
  versions: Array<{ version: number; snapshot: unknown; actor: string; created_at: string }>;
  audit: Array<Record<string, unknown>>;
}

export interface StartPreviewResponse {
  blocks: Array<{
    label: string;
    slot?: string;
    text: string;
    tokens: number;
    source?: string;
    block_id?: number;
  }>;
  budget_used: number;
  maintenance: { level: 'low' | 'medium' | 'high'; hint: string };
  notices?: string[];
  hook_check?: Record<string, unknown>;
  protocol?: string;
}

export type TermKind = 'entity' | 'intent' | 'concept';

export interface GraphNode {
  id: string;
  label: string;
  kind: TermKind;
  df: number;
  heat: number;
  degree: number;
  cluster: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface GraphCluster {
  id: string;
  name: string;
  node_count: number;
  heat: number;
  kind: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  focus: string | null;
  truncated: boolean;
  total_nodes: number;
}

/* ---- 分层图谱：L1 → L2 → 关键词 → L3 ---- */

export type LayeredNodeType = 'l1' | 'card' | 'term' | 'raw';
export type LayeredEdgeType = 'holds' | 'mentions' | 'co_occur' | 'evidence';

export interface LayeredNode {
  id: string;
  type: LayeredNodeType;
  layer: 0 | 1 | 2 | 3;
  label: string;
  sublabel?: string;
  heat: number;
  expandable: boolean;
  child_count: number;
  meta: Record<string, unknown>;
}

export interface LayeredEdge {
  id: string;
  source: string;
  target: string;
  type: LayeredEdgeType;
  weight: number;
  label?: string;
}

export interface RadialGraphPayload {
  nodes: LayeredNode[];
  edges: LayeredEdge[];
  stats: { cards: number; terms: number; raws: number; blocks: number; skills: number; skeleton: number };
}

export interface RecallPayload {
  query: string;
  scope: string;
  budget_limit: number;
  budget_used: number;
  blocks: Array<{ label: string; slot?: string; text: string; tokens: number; source?: string }>;
  recent_index: Array<{ event_id: number; keywords: string[] }>;
  cards: Array<{
    id: number;
    event_id: number;
    summary: string;
    intent: string | null;
    keywords: string[];
    entities: string[];
    importance: number;
    heat: number;
    score: number;
    tokens: number;
    stale: boolean;
    skeleton: boolean;
  }>;
  hints: Array<{ card_id: number; text: string; summary: string }>;
  dropped: Array<{ key: string; kind: string; tokens: number; reason: string }>;
  dropped_count: number;
  truncated: boolean;
  trace?: { seeds: Array<{ id: number; name: string }>; terms: Array<{ id: number; name: string; ppr: number }>; candidates: number; elapsed_ms: number };
  injection_order?: string[];
  note?: string;
}

export interface Candidate {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  evidence: number[];
  score: number;
  status: string;
  created_at: string;
  reviewed_at: string | null;
}

export interface TrashItem {
  kind: 'soft' | 'snapshot';
  id: number;
  object_type: string;
  object_id: number;
  title: string;
  created_at: string;
  purge_at?: string;
}

export interface AuditItem {
  id: number;
  object_type: string;
  object_id: number;
  op: string;
  actor: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
}

export interface MetricsResponse {
  recall: {
    count: number;
    avg_budget_used: number;
    max_budget_used: number;
    avg_budget_utilization: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    hit_cards: number;
    dropped: number;
  };
  write: {
    events: number;
    condensed: number;
    condensed_new: number;
    appended: number;
    condense_failed: number;
  };
  uptime_ms: number;
  counts: {
    cards: number;
    terms: number;
    edges: number;
    raws: number;
    blocks: number;
    candidates: number;
    trash: number;
  } | null;
  config: {
    budget: { defaultTokens: number; maxTokens: number };
    life: Record<string, number>;
    write: { condenseTurnThreshold: number; condenseMaxAttempts: number };
  };
}

/* ---- 运行时参数 */

export type SettingValue = number | boolean | string[];

export interface SettingEntry {
  key: string;
  env: string;
  group: 'budget' | 'life' | 'write' | 'blocks' | 'worker';
  label: string;
  hint: string;
  type: 'number' | 'boolean' | 'labels';
  unit?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
  restart?: boolean;
  options?: string[];
  value: SettingValue;
  default: SettingValue;
  source: 'db' | 'env' | 'default';
}

export interface SettingsResponse {
  groups: Array<{ key: string; title: string; description: string }>;
  entries: SettingEntry[];
  service: Array<{ label: string; value: string; hint: string }>;
  updated_at: string | null;
  restart_pending: boolean;
}

/* ------------------------------------------------------------------ api */

export const api = {
  settings: () => request<SettingsResponse>('/api/settings'),

  putSettings: (values: Record<string, SettingValue>) =>
    request<{ changed: string[]; restart_pending: boolean }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),

  resetSetting: (key: string) =>
    request<{ key: string; value: SettingValue }>(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),

  health: () => request<{ ok: boolean; time: string }>('/api/health'),

  metrics: () => request<MetricsResponse>('/api/metrics'),

  cards: (params: {
    q?: string;
    term?: string;
    intent?: string;
    scope?: string;
    from?: string;
    to?: string;
    stale?: boolean;
    include_skeleton?: boolean;
    page?: number;
    page_size?: number;
  }) =>
    request<CardListResponse>(
      `/api/cards${qs({
        q: params.q,
        term: params.term,
        intent: params.intent,
        scope: params.scope,
        from: params.from,
        to: params.to,
        stale: params.stale,
        include_skeleton: params.include_skeleton,
        page: params.page,
        page_size: params.page_size,
      })}`,
    ),

  card: (id: number) => request<CardDetailResponse>(`/api/cards/${id}`),

  patchCard: (id: number, patch: Record<string, unknown>) =>
    request<{ version: number; audit_id: number }>(`/api/cards/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteCard: (id: number, mode: 'soft' | 'purge', confirm = false) =>
    request<unknown>(`/api/cards/${id}${qs({ mode, confirm })}`, { method: 'DELETE' }),

  feedbackCard: (id: number, verdict: 'wrong' | 'irrelevant' | 'helpful', note?: string) =>
    request<{ card_id: number; verdict: string; confidence: number; audit_id: number }>(
      `/api/cards/${id}/feedback`,
      { method: 'POST', body: JSON.stringify({ verdict, note }) },
    ),

  expand: (body: { card_id?: number; term?: string | number; limit?: number }) =>
    request<{
      card: { id: number; summary: string; terms: Array<{ id: number; name: string; kind: string }> } | null;
      term: { id: number; name: string; kind: string; df: number; heat: number; aliases: string[] } | null;
      neighbors: Array<{ id: number; name: string; kind: string; df: number; heat: number; type: string; weight: number }>;
      cards: Array<{ id: number; summary: string; intent: string | null; heat: number; skeleton: boolean }>;
      raw_refs: Array<{ raw_id: number; seq: number; role: string; content: string; ts: string; archived: boolean }>;
      next: { term_ids: number[]; card_ids: number[] };
      note?: string;
    }>('/api/expand', { method: 'POST', body: JSON.stringify(body) }),

  recall: (body: {
    query: string;
    budget_tokens?: number;
    include_weak?: boolean;
    scope?: string;
    debug?: boolean;
  }) => request<RecallPayload>('/api/recall', { method: 'POST', body: JSON.stringify(body) }),

  blocks: () => request<BlockItem[]>('/api/blocks'),

  startPreview: () => request<StartPreviewResponse>('/api/start/preview'),

  putBlock: (label: string, content: string, slot = 'default', summary?: string) =>
    request<{ version: number }>(`/api/blocks/${label}`, {
      method: 'PUT',
      body: JSON.stringify({ content, slot, ...(summary === undefined ? {} : { summary }) }),
    }),

  deleteBlock: (id: number) => request<{ affected: Array<{ id: number }> }>(`/api/blocks/${id}?mode=soft`, { method: 'DELETE' }),

  blockVersions: (label: string, slot = 'default') =>
    request<Array<{ version: number; snapshot: unknown; actor: string; created_at: string }>>(
      `/api/blocks/${label}/versions${qs({ slot })}`,
    ),

  terms: (params: { q?: string; kind?: string; page?: number; page_size?: number }) =>
    request<{ items: Array<{ id: number; name: string; kind: string; aliases: string[]; df: number; heat: number; card_count: number }>; total: number }>(
      `/api/terms${qs({ q: params.q, kind: params.kind, page: params.page, page_size: params.page_size })}`,
    ),

  mergeTerm: (id: number, targetId: number) =>
    request<{ movedCards: number }>(`/api/terms/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ target_id: targetId }),
    }),

  graph: (params: { focus?: string; limit?: number } = {}) =>
    request<GraphPayload>(`/api/graph${qs({ focus: params.focus, limit: params.limit ?? 200 })}`),

  graphRadial: (params: { minCards?: number; heatTop?: number } = {}) =>
    request<RadialGraphPayload>(
      `/api/graph/radial${qs({ min_cards: params.minCards, heat_top: params.heatTop })}`,
    ),

  candidates: (status = 'pending') => request<Candidate[]>(`/api/candidates${qs({ status })}`),

  approve: (id: number) => request<{ block_id: number | null }>(`/api/candidates/${id}/approve`, { method: 'POST' }),

  reject: (id: number, reason?: string) =>
    request<{ rejected: number }>(`/api/candidates/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  audit: (params: { object_type?: string; object_id?: number; limit?: number } = {}) =>
    request<AuditItem[]>(`/api/audit${qs({ object_type: params.object_type, object_id: params.object_id, limit: params.limit ?? 100 })}`),

  trash: () => request<TrashItem[]>('/api/trash'),

  restoreSoft: (type: string, id: number) =>
    request<{ restored: number }>(`/api/trash/soft/${type}/${id}/restore`, { method: 'POST' }),

  restoreSnapshot: (id: number) => request<{ restored: number }>(`/api/trash/${id}/restore`, { method: 'POST' }),

  patrol: () =>
    request<{
      duration_ms: number;
      skeletonized: number;
      demotion: number;
      archived_raw: number;
      purged_trash: number;
      evicted: number;
    }>('/api/admin/patrol', { method: 'POST' }),
};
