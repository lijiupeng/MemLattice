import { clampText, splitSentences, uniq } from './text.js';
import { tokenizeKeywords, type Tokenizer } from './tokenizer.js';

/**
 * 事件卡内容全部在本地由规则生成，或直接采用调用方（Agent）传入的字段。
 * 服务端不调用任何模型：语义抽取由 MCP 调用方完成，这里只做校验与兜底。
 */

export const INTENTS = [
  '查状态',
  '求推荐',
  '排错',
  '决策',
  '学习',
  '信息同步',
  '情感交流',
] as const;
export type Intent = (typeof INTENTS)[number];

export function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

export interface CondenseMessage {
  role: string;
  content: string;
  tool_name?: string | null;
}

export interface CondensedCard {
  summary: string;
  intent: Intent;
  keywords: string[];
  entities: string[];
  importance: number;
  category: 'general' | 'person';
}

/** 调用方可选提供的卡字段（MCP memory.write 的 card 参数） */
export interface CardOverrides {
  summary?: string;
  intent?: string;
  keywords?: readonly string[];
  entities?: readonly string[];
  importance?: number;
  category?: 'general' | 'person';
}

const INTENT_RULES: Array<{ intent: Intent; patterns: RegExp }> = [
  { intent: '排错', patterns: /报错|错误|失败|异常|不工作|崩|bug|traceback|exception|error/i },
  { intent: '求推荐', patterns: /推荐|哪个好|选哪个|买什么|用什么|建议|值得/i },
  { intent: '决策', patterns: /要不要|该不该|还是|取舍|对比|选 ?[ab]|方案/i },
  { intent: '学习', patterns: /怎么|如何|原理|区别|为什么|是什么|教程/i },
  { intent: '查状态', patterns: /行情|涨跌|状态|进度|怎么样了|多少|现在|查询/i },
  { intent: '情感交流', patterns: /难过|开心|焦虑|压力|累|烦|谢谢/i },
];

export function guessIntent(text: string): Intent {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.test(text)) return rule.intent;
  }
  return '信息同步';
}

const PERSON_PATTERNS = /女朋友|男朋友|老婆|老公|父亲|母亲|爸爸|妈妈|同事|朋友|孩子|女儿|儿子|领导|老板/;

export function guessCategory(text: string): 'general' | 'person' {
  return PERSON_PATTERNS.test(text) ? 'person' : 'general';
}

const ENTITY_PATTERNS =
  /《[^》]{1,30}》|「[^」]{1,30}」|"[^"]{1,30}"|\b[A-Z][A-Za-z0-9.+#-]{1,24}\b|[\u4e00-\u9fff]{1,8}(?:公司|基金|股票|项目|产品|系统|模型|框架)/g;

function extractEntities(text: string): string[] {
  const found = text.match(ENTITY_PATTERNS) ?? [];
  return uniq(
    found
      .map((s) => s.replace(/^[《「"]|[》」"]$/g, '').trim())
      .filter((s) => s.length >= 2 && s.length <= 30),
  ).slice(0, 5);
}

/** 关键词打分：词频 + 是否出现在用户话里 + 词长加权，取分最高的 3 个（关联性最强）。 */
export function rankKeywords(tokenizer: Tokenizer, messages: readonly CondenseMessage[]): string[] {
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const allText = messages.map((m) => m.content).join('\n');
  const freq = new Map<string, number>();
  const userSet = new Set(tokenizeKeywords(tokenizer, userText));

  for (const token of tokenizeKeywords(tokenizer, allText)) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  const scored = [...freq.entries()]
    .map(([token, count]) => ({
      token,
      score: count * 1.0 + (userSet.has(token) ? 1.5 : 0) + (token.length >= 3 ? 0.4 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));

  const picked: string[] = [];
  for (const { token } of scored) {
    // 避免同一语义的碎片同时入选（如 "股票" 与 "股票行情"）
    if (picked.some((p) => p.includes(token) || token.includes(p))) continue;
    picked.push(token);
    if (picked.length >= 3) break;
  }
  return picked;
}

/** 关键词清洗：去空白、限长 2–12、去重，最多 8 个。数量上限靠 MCP 文字约束引导调用方，代码不硬拦。 */
export function sanitizeKeywords(values: readonly unknown[]): string[] {
  return uniq(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length >= 2 && value.length <= 12),
  ).slice(0, 8);
}

function sanitizeEntities(values: readonly unknown[]): string[] {
  return uniq(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length >= 2 && value.length <= 30),
  ).slice(0, 5);
}

export function clampSummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const clipped = clampText(compact, 200);
  if (clipped.length >= 40) return clipped;
  const fallback = `${clipped}（该事件内容较短，完整细节见明细层原始记录）`;
  return clampText(fallback, 200);
}

/** 规则式浓缩：调用方未提供字段时的兜底，保证写入链路不依赖任何模型。 */
export function ruleCondense(tokenizer: Tokenizer, messages: readonly CondenseMessage[]): CondensedCard {
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const assistantText = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n');
  const fullText = messages.map((m) => m.content).join('\n');
  const keywords = rankKeywords(tokenizer, messages);
  const intent = guessIntent(userText || fullText);
  const entities = extractEntities(fullText);
  const category = guessCategory(fullText);

  const topic = keywords.join('、') || '该话题';
  const asks = splitSentences(userText).slice(0, 2).join(' ');
  const conclusions = splitSentences(assistantText).slice(0, 3).join(' ');

  const pieces: string[] = [`【${intent}】围绕${topic}展开。`];
  if (asks) pieces.push(`诉求：${asks}`);
  if (conclusions) pieces.push(`结论：${conclusions}`);
  if (!conclusions) pieces.push('结论：已完成信息记录，细节保留在明细层。');

  let summary = pieces.join(' ');
  if ([...summary].length < 120) {
    const more = splitSentences(userText).slice(2, 6).join(' ');
    if (more) summary += ` 补充：${more}`;
  }

  const importance = Math.min(
    1,
    0.45 +
      (intent === '决策' || intent === '排错' ? 0.15 : 0) +
      (keywords.length >= 6 ? 0.1 : 0) +
      (category === 'person' ? 0.1 : 0),
  );

  return {
    summary: clampSummary(summary),
    intent,
    keywords: keywords.slice(0, 8),
    entities,
    importance: Math.round(importance * 100) / 100,
    category,
  };
}

/**
 * 合并调用方提供的字段与规则兜底：调用方给了就用（经校验），没给才由规则补齐。
 * 关键词是首要的调用方字段——服务端不做语义抽取。
 */
export function composeCard(
  tokenizer: Tokenizer,
  messages: readonly CondenseMessage[],
  overrides: CardOverrides = {},
): CondensedCard {
  const base = ruleCondense(tokenizer, messages);

  const summary =
    typeof overrides.summary === 'string' && overrides.summary.trim().length > 0
      ? clampSummary(overrides.summary)
      : base.summary;

  const keywords = Array.isArray(overrides.keywords) ? sanitizeKeywords(overrides.keywords) : [];
  const entities = Array.isArray(overrides.entities) ? sanitizeEntities(overrides.entities) : [];

  const importance =
    typeof overrides.importance === 'number' && Number.isFinite(overrides.importance)
      ? Math.round(Math.max(0, Math.min(1, overrides.importance)) * 100) / 100
      : base.importance;

  return {
    summary,
    intent: isIntent(overrides.intent) ? overrides.intent : base.intent,
    keywords: keywords.length > 0 ? keywords : base.keywords,
    entities: entities.length > 0 ? entities : base.entities,
    importance,
    category:
      overrides.category === 'person' || overrides.category === 'general'
        ? overrides.category
        : base.category,
  };
}
