import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError, toErrorPayload } from '../core/errors.js';
import { INTENTS, type CardOverrides } from '../core/condense.js';
import { recordEvent, recordRecall } from '../metrics.js';
import {
  correct,
  expand,
  feedback,
  forget,
  inspect,
  recall,
  startSession,
  write,
  writeBatch,
  type WriteInput,
} from '../services/memory.service.js';
import { listCandidates, listCards } from '../services/governance.service.js';
import { sleepReport, triageItems } from '../services/maintenance.service.js';
import { getUserId, type Ctx } from '../services/context.js';
import type { Actor } from '../services/context.js';
import { assertAuthorized, assertOrigin } from './http.js';

type ToolArgs = Record<string, unknown>;

/** memory.write 与 memory.write.batch 共用的单组入参schema */
const WRITE_FIELDS = {
  messages: {
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] },
        content: { type: 'string' },
        tool_name: { type: 'string' },
        ts: { type: 'string', description: 'ISO 时间，缺省为当前时间' },
      },
      required: ['role', 'content'],
      additionalProperties: false,
    },
  },
  scope: { type: 'string', default: 'default', description: '会话/场景标识，同会话的卡互为合并候选' },
  event_id: { type: 'integer', description: '向同一事件续写时传入上一次返回的 event_id' },
  close: { type: 'boolean', description: '显式结束事件并触发成卡', default: false },
  source: {
    type: 'string',
    enum: ['user', 'external'],
    default: 'user',
    description: 'external 表示来自外部内容，永不进入 L1',
  },
  append_to: {
    type: 'integer',
    description: '追加到哪张已有关卡。是否追加由你在 recall 看到上下文后自行判断；不传则新建卡',
  },
  dedupe: {
    type: 'boolean',
    default: false,
    description:
      '仅当希望服务端按关键词/摘要相似度兜底合并时设为 true；默认不自动合并，判定权在调用方',
  },
  summary_mode: {
    type: 'string',
    enum: ['append', 'replace'],
    default: 'append',
    description:
      '配合 append_to 生效：append 在原摘要后滚动追加（默认）；replace 用本次 card.summary 覆盖原摘要，关键词/实体仍取并集',
  },
  new_event: {
    type: 'boolean',
    default: false,
    description: '强制新建事件，不复用同 scope 下最近未成卡的 open 事件',
  },
  card: {
    type: 'object',
    description:
      '由调用方（Agent 侧模型）提供的卡字段。keywords 优先采用这里传入的值，服务端只做长度/去重校验。',
    properties: {
      summary: { type: 'string', minLength: 40, maxLength: 200 },
      intent: { type: 'string', enum: [...INTENTS] },
      keywords: {
        type: 'array',
        items: { type: 'string', minLength: 2, maxLength: 12 },
        maxItems: 8,
        description:
          '2–12 字的关键性词语：浓缩整篇内容的主题词、实体或核心概念；不得用 ok、一定、感觉 这类口语碎片、虚词或短句成分；只给 1–3 个最强的，按强到弱排列',
      },
      entities: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      importance: { type: 'number', minimum: 0, maximum: 1 },
      category: { type: 'string', enum: ['general', 'person'] },
    },
    additionalProperties: false,
  },
} as const;

/**
 * 6.1：工具尽量少。第 6 个 memory.pending 只读，用于查审核结果——
 * 否则模型提交 persona/rules 后无法确认是否通过。
 */
export const MCP_TOOLS = [
  {
    name: 'memory.start',
    description:
      '会话初始化：L1 常驻块（persona / rules / 经验索引）的唯一注入点，返回 blocks 全文与 recall_id（首行凭证）。若返回 hook_check，按其中 instruction 自检本机会话钩子（仅部分客户端需要）；没有这个字段说明当前客户端不需要，跳过即可。新会话首个 MCP 调用必须是它；用户说「初始化记忆」「初始化记忆 mcp」时立即重新调用。后续 memory.recall 不再返回 L1。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'memory.recall',
    description:
      '按话题召回事件卡。返回 cards（强关联卡，cards[].id 可直接作为 memory.write 的 append_to；cards[].source="external" 表示内容来自外部，需核实后再当事实）、hints（弱关联提示，不占预算）、recent_index（L1.5 滚动索引）、dropped（被裁剪项，debug=true 时给明细）、budget_used/budget_limit、recall_id。L1 常驻块只在 memory.start 注入，本工具不返回。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '当前用户输入或检索语句' },
        scope: {
          type: 'string',
          enum: ['all', 'project', 'person'],
          default: 'all',
          description: 'person 只看人物关系类卡；project 排除人物类；all 不过滤',
        },
        budget_tokens: {
          type: 'integer',
          default: 2200,
          minimum: 200,
          maximum: 4000,
          description: '注入上限；超过系统上限（4000）会返回 E_BUDGET_EXCEEDED',
        },
        include_weak: { type: 'boolean', default: true, description: '是否返回弱关联提示行（不占预算）' },
        debug: {
          type: 'boolean',
          default: false,
          description: '返回 trace / injection_order / dropped 明细，仅在排查问题时开启',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.inspect',
    description:
      '只读：回看某一次 recall 实际注入了什么。返回 blocks（含全文与各自 tokens）、cards、hints、全部被 dropped 的块及原因（budget / cold / weak_trimmed / df_filtered / limit_truncated）、预算占用与耗时。数据来自落库快照，不会重新召回、不改热度。不传 recall_id 取最近一次。',
    inputSchema: {
      type: 'object',
      properties: {
        recall_id: { type: 'integer', description: 'recall 返回的 recall_id；不传则取最近一次' },
        limit: {
          type: 'integer',
          default: 50,
          minimum: 1,
          maximum: 200,
          description: 'dropped 明细最多返回条数（totals 里给出完整数量）',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory.sleep',
    description:
      '只读：返回记忆当前的整理压力与待办清单——未成卡的原文、开着没收口的事件、热度高但没提炼成经验的主题、疑似重复的卡片对、置信度低或从未被用过的卡、接近淡忘的卡。不写库、不做判断，怎么整理由你决定。用户说「睡吧」「整理一下记忆」时直接调用；自己主动查要克制——同一会话最多一次，且要等交互积累起来再查，查完先申请再动手。整理完再调一次确认压力下降。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          default: 5,
          minimum: 1,
          maximum: 20,
          description: '每类清单最多返回几条',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory.triage',
    description:
      '把 memory.sleep 清单里判断过、决定不处理的项记下来，之后不再重复列出。只影响清单，不动记忆本身。适用：原文不值得成卡、主题已被现有经验覆盖、卡片确认要留着。批量传，同一批一次提交。标错了用 mode=clear 撤销，被撤销的项会重新出现在清单里。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['raw', 'term', 'card'] },
              id: { type: 'integer' },
            },
            required: ['type', 'id'],
            additionalProperties: false,
          },
        },
        mode: {
          type: 'string',
          enum: ['mark', 'clear'],
          default: 'mark',
          description: 'mark=标记为不处理；clear=撤销标记，重新回到清单',
        },
        reason: { type: 'string', description: '为什么不需要处理，会落库' },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.expand',
    description:
      '下钻一跳：按 card_id / block_id / term 取下层内容、L3 原文引用，以及可继续下钻的 next.card_ids / next.term_ids。L1【经验索引】里的 #id 就是 block_id，用它取回经验正文。不含两跳展开，连续调用即可逐层下钻。',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'integer', description: '事件卡 ID（与 block_id / term 三选一）' },
        block_id: {
          type: 'integer',
          description: '经验块 ID：L1【经验索引】里每行的 #id，取回该条经验正文与来源指针',
        },
        term: { type: ['string', 'integer'], description: '词名或词 ID（与 card_id / block_id 三选一）' },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory.write',
    description:
      '写入一轮或多轮对话到 L3 明细层，并成 L2 事件卡。可攒批：一次 messages 传多轮，收尾传 close=true 成卡（累计达到阈值也会自动成卡），不必每轮调用一次。不传 event_id 时会自动续写同 scope 下最近未成卡的事件（默认 30 分钟内，返回 resumed=true），所以连续对话可以每轮直接写；要另起一件事请换 scope、先 close，或传 new_event=true。摘要、意图、关键词由调用方通过 card 参数提供（服务端不做语义生成）；未提供的字段才用规则兜底。是否并入已有关卡由调用方判断：先 recall 看上下文，若仍是同一件事就传 append_to=<card_id>，否则不传即新建。服务端默认不做相似度合并（dedupe=true 才启用兜底）。',
    inputSchema: {
      type: 'object',
      properties: WRITE_FIELDS,
      required: ['messages'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.write.batch',
    description:
      '一次提交多组独立的写入（每组等价于一次 memory.write，各自成事件/卡），减少往返。适合一次落多条互不相关的事，或补录历史对话。items 顺序执行、组间隔离：某组失败只回填该组 error，不影响其它组。注意：要让多轮对话进同一个事件，用 memory.write 的 event_id 续写 + close，而不是把同一事件拆成多组。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: WRITE_FIELDS,
            required: ['messages'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.cards',
    description:
      '只读：按关键词 / 入口词 / 意图 / 场景搜索事件卡，返回 id 与摘要，用于决定 memory.correct / memory.forget 的目标。默认排除骨架卡，按热度倒序。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '匹配摘要、关键词、实体' },
        term: { type: 'string', description: '入口词名（含别名）' },
        intent: { type: 'string', enum: [...INTENTS] },
        scope: { type: 'string', description: '场景标识（mem_event.session_id）' },
        stale: { type: 'boolean', default: false, description: '只看 stale 卡' },
        include_skeleton: { type: 'boolean', default: false, description: '是否包含骨架卡' },
        page: { type: 'integer', default: 1, minimum: 1 },
        page_size: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory.feedback',
    description:
      '纠正记忆：只用于「召回出来的内容与事实不符、或与当前问题完全无关」这一种情况，正常使用不要调用——采用率由 expand 与 append_to 自动累计。wrong 下调该卡可信度并留审计，irrelevant 只记一次噪声票，helpful 视为一次采用。',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'integer', description: '要反馈的卡 ID' },
        verdict: {
          type: 'string',
          enum: ['wrong', 'irrelevant', 'helpful'],
          description: 'wrong=内容有误；irrelevant=完全不相关；helpful=确实用上了',
        },
        note: { type: 'string', description: '为什么判错，一句话，会进审计' },
      },
      required: ['card_id', 'verdict'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.correct',
    description:
      '更正 L2 事件卡、L1 常驻块（persona / rules / skills 三类均可写）或词节点。三类默认直写并留版本与审计；改的是常驻块时返回 reload_required=true，必须重新调用 memory.start 才会注入新版本，否则本会话仍按旧内容行事。若部署配置 BLOCK_APPROVAL_LABELS 包含对应 label，非人工写入会返回 pending_approval=true 与 candidate_id，人工批准后才生效。',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          description: 'card 用 id；block 用 label（+ 可选 slot）；term 用 id',
          properties: {
            type: { type: 'string', enum: ['card', 'block', 'term'] },
            id: { type: 'integer' },
            label: { type: 'string', enum: ['persona', 'rules', 'skills'] },
            slot: {
              type: 'string',
              description:
                'skills：缺省 default 表示通用经验，按词条目用 skill:<term_id>；其它 label 固定 default',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
        patch: {
          type: 'object',
          description:
            'card：summary / intent / keywords / entities / importance / category / pinned；block：content / summary；term：name / aliases / kind',
          properties: {
            summary: {
              type: 'string',
              description:
                'card：摘要 40–200 字；skills 的 skill:<term_id>：一句话描述（≤60 字，说明这个技能干什么用，只有它进 L1 经验索引；缺省时从 content 条件段兜底）',
            },
            intent: { type: 'string', enum: [...INTENTS] },
            keywords: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 8,
              description:
                '建议 1–3 个浓缩全篇的关键性词语（主题词/实体/核心概念），禁用口语碎片与虚词（如 ok、一定、感觉）',
            },
            entities: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            category: { type: 'string', enum: ['general', 'person'] },
            pinned: { type: 'boolean' },
            content: {
              type: 'string',
              description:
                'block 正文。skills 的 skill:<term_id> 槽位里它是**详细描述**（默认 ≤4000 字，SKILL_DETAIL_MAX_CHARS 可调）',
            },
            name: { type: 'string', description: 'term 名称（会归一化）' },
            aliases: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string', enum: ['entity', 'intent', 'concept'] },
          },
          additionalProperties: true,
        },
        reason: { type: 'string' },
      },
      required: ['target', 'patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.forget',
    description:
      '遗忘：mode=soft 只让这张卡不再出现在检索结果里（7 天内可在回收站恢复）；mode=skeleton 把冷卡压成骨架卡并断开原文，卡还在、只是不再持有细节，不可逆；mode=purge 物理清除（需 confirm=true，先进回收站快照）。block 用 label(+slot) 定位；L3 原文不支持单条删除。重要、钉住、人物关系类的卡不会被压成骨架。',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['card', 'block', 'term'] },
            id: { type: 'integer' },
            label: { type: 'string' },
            slot: { type: 'string' },
          },
          required: ['type'],
          additionalProperties: false,
        },
        mode: { type: 'string', enum: ['soft', 'skeleton', 'purge'], default: 'soft' },
        confirm: { type: 'boolean', default: false },
        reason: { type: 'string' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory.pending',
    description:
      '只读：查看待审/已审候选。不传 candidate_id 时按 status 列出候选（默认 pending）；传了则返回该条的最新状态（pending/approved/rejected）、kind、payload 与审核时间。审批与驳回只能由人工在 Web 端完成。',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'integer', description: '查单条时传，忽略 status 过滤' },
        status: {
          type: 'string',
          enum: ['pending', 'approved', 'rejected', 'all'],
          default: 'pending',
        },
        kind: { type: 'string', enum: ['block', 'skill', 'merge', 'rule'] },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
] as const;

/** 把 MCP 入参映射成 write 的 service 入参；write 与 write.batch 共用 */
function toWriteInput(args: ToolArgs, actor: Actor): WriteInput {
  return {
    messages: (Array.isArray(args.messages) ? args.messages : []) as Array<{
      role: string;
      content: string;
      tool_name?: string;
      ts?: string;
    }>,
    scope: typeof args.scope === 'string' ? args.scope : undefined,
    event_id: args.event_id === undefined ? undefined : Number(args.event_id),
    close: args.close === true,
    source: args.source === 'external' ? 'external' : 'user',
    actor,
    card: (args.card ?? undefined) as CardOverrides | undefined,
    append_to: args.append_to === undefined ? undefined : Number(args.append_to),
    dedupe: args.dedupe === true ? true : undefined,
    summary_mode: args.summary_mode === 'replace' ? 'replace' : undefined,
    new_event: args.new_event === true ? true : undefined,
  };
}

export async function callTool(ctx: Ctx, name: string, args: ToolArgs, actor: Actor = 'agent'): Promise<unknown> {
  const userId = await getUserId(ctx);
  switch (name) {
    case 'memory.start':
      return startSession(ctx, userId);
    case 'memory.recall': {
      const started = Date.now();
      const result = await recall(ctx, {
        query: String(args.query ?? ''),
        scope: (args.scope as 'all' | 'project' | 'person') ?? 'all',
        budgetTokens: args.budget_tokens === undefined ? undefined : Number(args.budget_tokens),
        includeWeak: args.include_weak === undefined ? undefined : Boolean(args.include_weak),
        debug: args.debug === true,
        actor,
      });
      recordRecall({
        budgetUsed: result.budget_used,
        budgetLimit: result.budget_limit,
        hitCards: result.cards.length,
        dropped: result.dropped.length,
        latencyMs: Date.now() - started,
      });
      return result;
    }
    case 'memory.inspect':
      return inspect(ctx, {
        userId,
        recallId: args.recall_id === undefined ? undefined : Number(args.recall_id),
        limit: args.limit === undefined ? undefined : Number(args.limit),
      });
    case 'memory.sleep':
      return sleepReport(ctx, userId, args.limit === undefined ? undefined : Number(args.limit));
    case 'memory.triage': {
      const items = Array.isArray(args.items) ? (args.items as ToolArgs[]) : [];
      if (items.length === 0) {
        throw new AppError('E_INVALID', 'items 不能为空', { field: 'items' });
      }
      const parsed: Array<{ type: 'raw' | 'term' | 'card'; id: number }> = items.map((item) => {
        const type = item.type;
        const id = Number(item.id);
        if (type !== 'raw' && type !== 'term' && type !== 'card') {
          throw new AppError('E_INVALID', 'type 只接受 raw / term / card', {
            field: 'items[].type',
            value: type,
          });
        }
        if (!Number.isInteger(id)) {
          throw new AppError('E_INVALID', 'id 必须是整数', {
            field: 'items[].id',
            value: item.id,
          });
        }
        return { type, id };
      });
      return triageItems(
        ctx,
        userId,
        parsed,
        args.mode === 'clear' ? 'clear' : 'mark',
        typeof args.reason === 'string' ? args.reason : undefined,
      );
    }
    case 'memory.expand':
      return expand(ctx, {
        cardId: args.card_id === undefined ? undefined : Number(args.card_id),
        blockId: args.block_id === undefined ? undefined : Number(args.block_id),
        term: args.term as string | number | undefined,
        depth: args.depth === undefined ? undefined : Number(args.depth),
        limit: args.limit === undefined ? undefined : Number(args.limit),
        actor,
      });
    case 'memory.write': {
      const result = await write(ctx, toWriteInput(args, actor));
      recordEvent(!result.card_pending, false, result.appended === true);
      return result;
    }
    case 'memory.write.batch': {
      const items = Array.isArray(args.items) ? (args.items as ToolArgs[]) : [];
      const batch = await writeBatch(
        ctx,
        items.map((item) => toWriteInput(item, actor)),
      );
      // 只统计成功写入的组；校验失败的组不是浓缩失败，不污染 condense_failed
      for (const item of batch.items) {
        if (item.result) {
          recordEvent(!item.result.card_pending, false, item.result.appended === true);
        }
      }
      return batch;
    }
    case 'memory.cards': {
      const result = await listCards(ctx, userId, {
        q: typeof args.q === 'string' ? args.q : undefined,
        term: typeof args.term === 'string' ? args.term : undefined,
        intent: typeof args.intent === 'string' ? args.intent : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        staleOnly: args.stale === true,
        includeSkeleton: args.include_skeleton === true,
        page: args.page === undefined ? undefined : Number(args.page),
        pageSize: args.page_size === undefined ? undefined : Number(args.page_size),
      });
      return {
        items: result.items.map((item) => ({
          card_id: Number(item.id),
          event_id: Number(item.event_id),
          summary: item.summary,
          intent: item.intent,
          keywords: item.keywords,
          heat: Number(item.heat),
          confidence: Number(item.confidence),
          use_count: Number(item.use_count),
          hit_count: Number(item.hit_count),
          stale: item.stale,
          is_skeleton: item.is_skeleton,
          raw_count: Number(item.raw_count),
          created_at: item.created_at,
        })),
        total: result.total,
        page: result.page,
        page_size: result.pageSize,
      };
    }
    case 'memory.feedback': {
      const cardId = Number(args.card_id);
      if (!Number.isInteger(cardId)) {
        throw new AppError('E_INVALID', 'card_id 必须是整数', {
          field: 'card_id',
          value: args.card_id,
        });
      }
      const verdict = args.verdict;
      if (verdict !== 'wrong' && verdict !== 'irrelevant' && verdict !== 'helpful') {
        throw new AppError('E_INVALID', 'verdict 只接受 wrong / irrelevant / helpful', {
          field: 'verdict',
          value: verdict,
        });
      }
      return feedback(ctx, {
        userId,
        cardId,
        verdict,
        note: typeof args.note === 'string' ? args.note : undefined,
        actor,
      });
    }
    case 'memory.correct':
      return correct(ctx, {
        userId,
        target: (args.target ?? {}) as { type: 'card' | 'block' | 'term' },
        patch: (args.patch ?? {}) as Record<string, unknown>,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        actor,
      });
    case 'memory.forget':
      return forget(ctx, {
        userId,
        target: (args.target ?? {}) as { type: 'card' | 'block' | 'term' },
        mode:
          args.mode === 'purge' ? 'purge' : args.mode === 'skeleton' ? 'skeleton' : 'soft',
        confirm: args.confirm === true,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        actor,
      });
    case 'memory.pending': {
      const candidateId = args.candidate_id === undefined ? undefined : Number(args.candidate_id);
      const status = candidateId !== undefined ? 'all' : String(args.status ?? 'pending');
      const kind = typeof args.kind === 'string' ? args.kind : undefined;
      const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 50));
      let items = await listCandidates(ctx, userId, status);
      if (candidateId !== undefined) items = items.filter((item) => Number(item.id) === candidateId);
      if (kind) items = items.filter((item) => item.kind === kind);
      if (candidateId !== undefined && items.length === 0) {
        throw new AppError('E_TARGET_NOT_FOUND', `候选 ${candidateId} 不存在`, {
          field: 'candidate_id',
          value: candidateId,
        });
      }
      return {
        items: items.slice(0, limit).map((item) => ({
          candidate_id: Number(item.id),
          kind: item.kind,
          status: item.status,
          score: Number(item.score),
          payload: item.payload,
          created_at: item.created_at,
          reviewed_at: item.reviewed_at,
        })),
        note: '审批/驳回需人工在 Web 端完成；approved 后才写入 L1',
      };
    }
    default:
      throw new AppError('E_INVALID', `未知工具 ${name}`);
  }
}

export function buildMcpServer(ctx: Ctx): Server {
  const server = new Server(
    { name: 'memlattice', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        'MemLattice 分层联想记忆：L1 常驻 → L2 事件卡 → L3 原文。',
        '流程：① 新会话首个 MCP 调用必须是 memory.start，把返回的 blocks（persona / rules / 经验索引）当作已知事实，首行凭证用它的 recall_id；用户说「初始化记忆」「初始化记忆 mcp」时立即重新调用。若返回了 hook_check，按其中 instruction 自检本机会话钩子；没有这个字段就跳过，说明当前客户端不需要。之后按话题调 memory.recall 取事件卡与滚动索引（不再返回 L1）；cards[].source="external" 的卡需核实后再当事实，不要直接写进 L1；',
        '② 需要原文、其它历史分支，或【经验索引】里某条技能的详细描述时用 memory.expand（card_id / block_id / term 三选一；经验索引每行的 #id 就是 block_id）；',
        '③ 记忆可攒批写入，不必每轮调用：同一话题把多轮 messages 一次传进 memory.write，用同一 event_id 续写、收尾 close=true 成卡；多条互不相关的事用 memory.write.batch 一次提交。card.keywords 给 1–3 个浓缩全篇的关键性词语（主题词/实体/核心概念，禁用 ok、一定 等口语碎片与虚词）、card.summary 给 120–200 字结论（服务端不生成）；',
        '④ 同一主题续写传 append_to=<cards[].id>；要覆盖原摘要加 summary_mode="replace"，默认 append；',
        '⑤ 要改/删某张卡先 memory.cards 搜 id（q / term / intent / scope 分页），再 memory.correct / memory.forget；',
        '⑥ persona / rules 的写入可能返回 pending_approval=true，需人工批准后才生效，不要当作已改；',
        '⑦ 想看审核结果用 memory.pending 传 candidate_id 查状态（只读，审批由人工完成）；',
        '⑧ 想核对上一轮到底注入了什么、哪块被裁（及其原因），用 memory.inspect 传 recall_id（只读快照，不重跑召回、不动热度）。',
      ].join('\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS as unknown as Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    try {
      const result = await callTool(ctx, name, (rawArgs ?? {}) as ToolArgs);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const { body } = toErrorPayload(err);
      return {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        isError: true,
      };
    }
  });

  return server;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeen: number;
}

/**
 * 6.1 / 2：HTTP 走 Streamable HTTP（单端点 + Mcp-Session-Id 会话头）。
 * 会话必须复用同一个 Server 实例，否则 tools 调用会因为"未初始化"被拒。
 */
export function registerMcpHttp(app: FastifyInstance, ctx: Ctx): void {
  const sessions = new Map<string, McpSession>();

  const sweep = setInterval(() => {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        void session.transport.close();
        void session.server.close();
        sessions.delete(id);
      }
    }
  }, 10 * 60_000);
  sweep.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    for (const session of sessions.values()) {
      await session.transport.close();
      await session.server.close();
    }
    sessions.clear();
  });

  const reject = async (reply: FastifyReply, status: number, message: string): Promise<void> => {
    await reply.code(status).send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message },
    });
  };

  app.post('/mcp', async (req, reply) => {
    try {
      assertOrigin(req, ctx.cfg);
      assertAuthorized(req, ctx.cfg);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      await reject(reply, status, body.error.message);
      return;
    }

    const headerId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;

    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      await reject(reply, 404, '会话不存在或已过期，请重新 initialize');
      return;
    }

    if (!session) {
      const server = buildMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };
      await server.connect(transport);
      session = { transport, server, lastSeen: Date.now() };
    } else {
      session.lastSeen = Date.now();
    }

    reply.hijack();
    try {
      await session.transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp http error');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
      }
      reply.raw.end(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP 内部错误' } }),
      );
    }
  });

  app.get('/mcp', async (req, reply) => {
    try {
      assertOrigin(req, ctx.cfg);
      assertAuthorized(req, ctx.cfg);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      await reject(reply, status, body.error.message);
      return;
    }
    const headerId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      await reject(reply, 400, '缺少有效的 Mcp-Session-Id');
      return;
    }
    session.lastSeen = Date.now();
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  });

  app.delete('/mcp', async (req, reply) => {
    try {
      assertOrigin(req, ctx.cfg);
      assertAuthorized(req, ctx.cfg);
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      await reject(reply, status, body.error.message);
      return;
    }
    const headerId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      await reject(reply, 404, '会话不存在');
      return;
    }
    sessions.delete(sessionId as string);
    reply.hijack();
    await session.transport.handleRequest(req.raw, reply.raw);
  });
}
