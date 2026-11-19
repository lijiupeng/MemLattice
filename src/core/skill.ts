import { clampText } from './text.js';
import { estimateTokens } from './tokens.js';

const ACTION_BY_INTENT: Record<string, string> = {
  查状态: '先给当前状态与关键变化，再补一句需要注意的点',
  求推荐: '先给候选与取舍，再落到一个明确建议',
  排错: '先复现与定位，再给出最小改动方案',
  决策: '先列约束与代价，再给结论',
  学习: '先给一句话结论，再给可验证的例子',
  信息同步: '先给结论，再给来源与时间',
  情感交流: '先共情，再给可执行的一小步',
};

export function intentAction(intent: string | null | undefined): string {
  if (intent && ACTION_BY_INTENT[intent]) return ACTION_BY_INTENT[intent] as string;
  return ACTION_BY_INTENT['信息同步'] as string;
}

/**
 * FR-15：固化条目形如 `[条件] → [动作]`，≤60 字，携带来源指针。
 */
export function buildSkillEntry(
  termName: string,
  intent: string | null | undefined,
  maxChars = 60,
): string {
  const condition = `提及${clampText(termName, 16)}${intent ? ` · ${intent}` : ''}`;
  const action = intentAction(intent);
  const full = `[${condition}] → [${action}]`;
  return clampText(full, maxChars);
}

const CONDITION_PATTERN = /^\s*\[([^\]]+)\]\s*(?:→|->)/;

/** 从 `[条件] → [动作]` 里取条件；格式不符（人工随手写的经验）退化为内容前 16 字。 */
export function skillCondition(content: string): string {
  const matched = CONDITION_PATTERN.exec(content.trim());
  if (matched?.[1]) return matched[1].trim();
  return clampText(content.trim(), 16);
}

export interface SkillIndexEntry {
  /** 经验的 mem_block.id，调用方据此按需取全文 */
  blockId: number;
  /** 一句话描述：这个技能是干什么的（存量数据可能为空，回退到条件解析） */
  summary?: string | null;
  /** 累计调用次数，仅用于索引行展示 */
  useCount?: number;
  content: string;
}

/** 索引行里显示的那句话：优先用 summary，没有就从 `[条件] → [动作]` 里取条件。 */
export function skillIndexLabel(entry: SkillIndexEntry): string {
  const summary = (entry.summary ?? '').trim();
  return summary || skillCondition(entry.content);
}

/**
 * 经验索引：L1 只注入"何时用 + 用哪个 id"，正文按 id 现取。
 * 这样经验条可以多存几十条而不挤占 L1 预算；代价是真正要用时多一次 expand 调用。
 */
export function buildSkillIndex(
  entries: readonly SkillIndexEntry[],
  options: { maxItems?: number; maxTokens?: number; toolName?: string } = {},
): { text: string; listed: number; omitted: number; blockIds: number[] } {
  const maxItems = Math.max(1, options.maxItems ?? 5);
  const maxTokens = options.maxTokens ?? 0;
  const tool = options.toolName ?? 'memory.expand';
  // 调用方按热度排好序传进来，这里只负责取前 N 条
  let listed = entries.slice(0, maxItems);

  // 索引本身占的常驻预算：超了就少列几条，而不是去删正文。
  // 预留量给「命中下列描述时…」那句固定说明，它比任何一条索引都长。
  if (maxTokens > 0) {
    const HEADER_RESERVE = 100;
    let used = HEADER_RESERVE;
    const kept: SkillIndexEntry[] = [];
    for (const entry of listed) {
      const cost = estimateTokens(
        `- #${entry.blockId} ${skillIndexLabel(entry)}${entry.useCount && entry.useCount > 0 ? `（${entry.useCount} 次）` : ''}`,
      );
      if (used + cost > maxTokens) break;
      used += cost;
      kept.push(entry);
    }
    listed = kept;
  }

  const omitted = Math.max(0, entries.length - listed.length);
  if (listed.length === 0) return { text: '', listed: 0, omitted: 0, blockIds: [] };

  const lines = listed.map((entry) => {
    const used = entry.useCount && entry.useCount > 0 ? `（${entry.useCount} 次）` : '';
    return `- #${entry.blockId} ${skillIndexLabel(entry)}${used}`;
  });
  const header =
    omitted > 0
      ? `【经验索引】按调用热度取前 ${listed.length} 条（共 ${entries.length} 条）。命中下列描述时，先用 ${tool} {"block_id": <id>} 取详细描述再执行，不要凭记忆猜：`
      : `【经验索引】命中下列描述时，先用 ${tool} {"block_id": <id>} 取详细描述再执行，不要凭记忆猜：`;
  const tail = omitted > 0 ? `\n（另有 ${omitted} 条未列出，可按需检索）` : '';
  return {
    text: [header, ...lines].join('\n') + tail,
    listed: listed.length,
    omitted,
    blockIds: listed.map((entry) => entry.blockId),
  };
}
