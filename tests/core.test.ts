import { describe, expect, it } from 'vitest';
import { estimateTokens, trimToTokens } from '../src/core/tokens.js';
import { makePackItem, pack } from '../src/core/packer.js';
import { personalizedPageRank, type PprEdge } from '../src/core/ppr.js';
import { cardScore, heatNorm, isCold, isStrong, precisionFactor } from '../src/core/scoring.js';
import { applyHeat, decayedValue, projectHeat } from '../src/core/heat.js';
import { clusterGraph } from '../src/core/cluster.js';
import { buildSkillIndex } from '../src/core/skill.js';
import { createFallbackTokenizer, uniqueTokens } from '../src/core/tokenizer.js';
import { buildSkillEntry, buildSkillIndex, skillIndexLabel } from '../src/core/skill.js';
import { INTENTS, composeCard, rankKeywords, ruleCondense, guessIntent } from '../src/core/condense.js';
import { decideAppend, mergeSummary, pickAppendTarget } from '../src/core/dedupe.js';
import { clampText, diceSimilarity, normalize, splitSentences } from '../src/core/text.js';
import { ALIAS_LINK, expandAliasSeeds } from '../src/core/alias.js';

const DAY = 86_400_000;

describe('token 估算与裁剪（G1 预算）', () => {
  it('中文按 1 字 1 token 保守估算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });

  it('拉丁文本按 3.5 字符 1 token', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil(11 / 3.5));
  });

  it('裁剪后 token 数不超过上限', () => {
    const text = '股票行情分析需要关注成交量与资金流向，以及板块轮动节奏';
    const trimmed = trimToTokens(text, 8);
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(8);
    expect(text.startsWith(trimmed)).toBe(true);
  });
});

describe('预算打包（FR-07 硬上限）', () => {
  it('装不下就停在预算处，并记录丢弃明细', () => {
    const items = [
      makePackItem({ key: 'a', kind: 'block', tier: 0, score: 1, text: '甲'.repeat(60) }),
      makePackItem({ key: 'b', kind: 'card', tier: 10, score: 0.9, text: '乙'.repeat(60) }),
      makePackItem({ key: 'c', kind: 'card', tier: 10, score: 0.8, text: '丙'.repeat(60) }),
    ];
    const result = pack(items, 100);
    expect(result.used).toBeLessThanOrEqual(100);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.included[0]?.key).toBe('a');
  });

  it('可截断条目只在句末截断，切不出整句就整块丢弃', () => {
    const withBoundary = pack(
      [
        makePackItem({ key: 'block', kind: 'block', tier: 0, score: 1, text: '规则'.repeat(20) }),
        makePackItem({
          key: 'skill',
          kind: 'block',
          tier: 3,
          score: 0.5,
          text: '先看结论。再补细节与例子。'.repeat(4),
          truncatable: true,
        }),
      ],
      60,
    );
    const skill = withBoundary.included.find((item) => item.key === 'skill');
    expect(skill?.truncated).toBe(true);
    expect(skill?.text.endsWith('。')).toBe(true);
    expect(withBoundary.used).toBeLessThanOrEqual(60);

    const noBoundary = pack(
      [
        makePackItem({ key: 'block', kind: 'block', tier: 0, score: 1, text: '规则'.repeat(20) }),
        makePackItem({
          key: 'skill',
          kind: 'block',
          tier: 3,
          score: 0.5,
          text: '经验'.repeat(40),
          truncatable: true,
        }),
      ],
      50,
    );
    expect(noBoundary.included.map((item) => item.key)).not.toContain('skill');
    expect(noBoundary.dropped.some((item) => item.key === 'skill' && item.reason === 'budget')).toBe(true);
  });

  it('排序先按 tier 再按性价比', () => {
    const items = [
      makePackItem({ key: 'card-hot', kind: 'card', tier: 10, score: 1, text: '热门卡片内容' }),
      makePackItem({ key: 'rules', kind: 'block', tier: 0, score: 0.1, text: '硬规则' }),
    ];
    expect(pack(items, 100).included[0]?.key).toBe('rules');
  });
});

describe('个性化 PageRank（8.2 子图扩散）', () => {
  const edges: PprEdge[] = [
    { src: 1, dst: 2, weight: 1 },
    { src: 1, dst: 3, weight: 1 },
    { src: 2, dst: 4, weight: 0.5 },
  ];

  it('种子自身得分最高，一跳邻居高于二跳', () => {
    const scores = personalizedPageRank([1, 2, 3, 4], edges, new Map([[1, 1]]));
    const seed = scores.get(1) ?? 0;
    const oneHop = scores.get(2) ?? 0;
    const twoHop = scores.get(4) ?? 0;
    expect(seed).toBeCloseTo(1, 5);
    expect(oneHop).toBeGreaterThan(twoHop);
  });

  it('结果按最大值归一化到 1', () => {
    const scores = personalizedPageRank([1, 2, 3], edges, new Map([[2, 1]]));
    expect(Math.max(...scores.values())).toBeCloseTo(1, 5);
  });

  it('空图返回空结果', () => {
    expect(personalizedPageRank([], [], new Map()).size).toBe(0);
  });
});

describe('热度衰减（FR-14）', () => {
  it('半衰期 14 天后衰减为一半', () => {
    expect(decayedValue(4, 14, 14 * DAY)).toBeCloseTo(2, 5);
  });

  it('增量更新先衰减再累加', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    const result = applyHeat(4, new Date(now.getTime() - 14 * DAY), 14, 1, now);
    expect(result.heat).toBeCloseTo(3, 5);
  });

  it('projectHeat 不会因时间倒流而膨胀', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    expect(projectHeat(2, now, 30, now)).toBeCloseTo(2, 5);
  });
});

describe('打分与强/弱关联（5.3）', () => {
  it('热度归一化有上限', () => {
    expect(heatNorm(0)).toBe(0);
    expect(heatNorm(100)).toBeLessThanOrEqual(1);
    expect(heatNorm(10)).toBeCloseTo(1, 5);
  });

  it('分数落在 0–1 且随 ppr 单调递增', () => {
    const base = { ageDays: 1, heat: 1, importance: 0.5 };
    const low = cardScore({ ...base, pprNorm: 0.1 });
    const high = cardScore({ ...base, pprNorm: 0.9 });
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThan(low);
  });

  it('强关联需三条同时满足', () => {
    expect(isStrong({ pprNorm: 0.4, ageDays: 10, overlap: 2 })).toBe(true);
    expect(isStrong({ pprNorm: 0.29, ageDays: 10, overlap: 2 })).toBe(false);
    expect(isStrong({ pprNorm: 0.4, ageDays: 40, overlap: 2 })).toBe(false);
    expect(isStrong({ pprNorm: 0.4, ageDays: 10, overlap: 1 })).toBe(false);
  });

  it('经验索引按 token 预算少列几条，而不是砍正文', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      blockId: i + 1,
      summary: `经验条目${i + 1}`,
      content: '',
      useCount: 0,
    }));
    const roomy = buildSkillIndex(entries, { maxItems: 10, maxTokens: 4000 });
    const tight = buildSkillIndex(entries, { maxItems: 10, maxTokens: 120 });
    expect(roomy.listed).toBe(10);
    expect(roomy.omitted).toBe(0);
    expect(tight.listed).toBeLessThan(roomy.listed);
    expect(tight.omitted).toBe(roomy.listed - tight.listed);
  });

  it('采用率折减：曝光不足不折，纯噪声折到六成', () => {
    expect(precisionFactor(0, 0)).toBe(1);
    expect(precisionFactor(0, 4)).toBe(1);
    expect(precisionFactor(5, 10)).toBeCloseTo(0.8, 5);
    expect(precisionFactor(0, 20)).toBeCloseTo(0.6, 5);
    expect(precisionFactor(20, 20)).toBeCloseTo(1, 5);
  });

  it('冷判定需热度低且长期未命中', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    expect(
      isCold({
        heat: 0.2,
        lastTouchedAt: new Date(now.getTime() - 120 * DAY),
        now,
        coldHeatThreshold: 0.5,
        coldIdleDays: 90,
      }),
    ).toBe(true);
    expect(
      isCold({
        heat: 0.2,
        lastTouchedAt: new Date(now.getTime() - 10 * DAY),
        now,
        coldHeatThreshold: 0.5,
        coldIdleDays: 90,
      }),
    ).toBe(false);
  });
});

describe('图谱聚类（cluster 视图）', () => {
  const nodes = [
    { id: 1, name: '股票', kind: 'entity', heat: 5 },
    { id: 2, name: '股市', kind: 'entity', heat: 4 },
    { id: 3, name: '行情', kind: 'concept', heat: 3 },
    { id: 4, name: '报错', kind: 'intent', heat: 1 },
  ];

  it('按连通分量分簇', () => {
    const result = clusterGraph(nodes, [
      { src: 1, dst: 2 },
      { src: 2, dst: 3 },
    ]);
    expect(result.clusters.length).toBe(2);
    expect(result.assignments.get(1)).toBe(result.assignments.get(2));
    expect(result.assignments.get(1)).not.toBe(result.assignments.get(4));
  });

  it('超大分量会被切分', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `词${i}`,
      kind: 'concept',
      heat: 1,
    }));
    const edges = many.slice(1).map((n) => ({ src: 1, dst: n.id }));
    const result = clusterGraph(many, edges, { maxClusterSize: 4 });
    expect(result.clusters.length).toBeGreaterThan(1);
    expect(result.clusters.every((c) => c.node_count <= 4)).toBe(true);
  });

  it('无边的节点按孤立簇处理', () => {
    const result = clusterGraph(nodes, []);
    expect(result.clusters.length).toBe(nodes.length);
  });
});

describe('固化条目格式（FR-15）', () => {
  it('形如 [条件] → [动作] 且不超过 60 字', () => {
    const entry = buildSkillEntry('股票', '求推荐', 60);
    expect(entry).toContain('→');
    expect([...entry].length).toBeLessThanOrEqual(60);
    expect(entry).toContain('股票');
  });

  it('超长词名会被截断但结构保持', () => {
    const entry = buildSkillEntry('这是一个非常非常非常长的记忆入口词名称用于测试', '排错', 60);
    expect([...entry].length).toBeLessThanOrEqual(60);
    expect(entry.startsWith('[')).toBe(true);
  });
});

describe('经验索引（L1 只给 id + 一句话描述）', () => {
  it('优先用 summary，没有才回退到条件解析', () => {
    expect(
      skillIndexLabel({ blockId: 1, summary: '部署出问题时按这个回滚', content: '[提及部署] → [先复位]' }),
    ).toBe('部署出问题时按这个回滚');
    expect(skillIndexLabel({ blockId: 2, summary: null, content: '[提及部署] → [先复位]' })).toBe(
      '提及部署',
    );
  });

  it('默认只列热度前 5 条，其余计数不展开', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      blockId: i + 1,
      summary: `技能${i + 1}`,
      useCount: 8 - i,
      content: `[条件${i + 1}] → [动作]`,
    }));
    const index = buildSkillIndex(entries);
    expect(index.listed).toBe(5);
    expect(index.omitted).toBe(3);
    expect(index.blockIds).toEqual([1, 2, 3, 4, 5]);
    expect(index.text).toContain('共 8 条');
    expect(index.text).toContain('另有 3 条未列出');
  });

  it('索引行是 id + 一句话描述，并带调用次数', () => {
    const index = buildSkillIndex([
      { blockId: 12, summary: '处理部署回滚', useCount: 7, content: '[提及部署] → [先复位]' },
    ]);
    expect(index.text).toContain('- #12 处理部署回滚（7 次）');
    expect(index.text).toContain('memory.expand');
    expect(index.text).toContain('block_id');
  });

  it('没有经验时返回空文本', () => {
    const index = buildSkillIndex([]);
    expect(index.text).toBe('');
    expect(index.blockIds).toEqual([]);
  });
});

describe('规则式浓缩（LLM 关闭时的降级路径）', () => {
  const tokenizer = createFallbackTokenizer();
  const messages = [
    { role: 'user', content: '今天股票行情怎么样？我持有的新能源板块要不要继续拿着，还是换到人工智能方向？' },
    { role: 'assistant', content: '新能源板块今天缩量回调，资金在向算力方向切换。建议先减掉三成仓位，保留底仓观察两天。' },
  ];

  it('摘要长度受约束，不逐句复述', () => {
    const card = ruleCondense(tokenizer, messages);
    expect([...card.summary].length).toBeLessThanOrEqual(200);
    expect([...card.summary].length).toBeGreaterThanOrEqual(40);
    expect(card.intent).toBeTruthy();
  });

  it('关键词 1–3 个且不含单字', () => {
    const card = ruleCondense(tokenizer, messages);
    expect(card.keywords.length).toBeGreaterThan(0);
    expect(card.keywords.length).toBeLessThanOrEqual(3);
    expect(card.keywords.every((k) => [...k].length >= 2)).toBe(true);
  });

  it('意图按规则识别', () => {
    expect(guessIntent('这个报错怎么解决')).toBe('排错');
    expect(guessIntent('该不该换工作')).toBe('决策');
  });

  it('关键词排序不会把同一词的碎片重复计入', () => {
    const picked = rankKeywords(tokenizer, messages);
    for (let i = 0; i < picked.length; i++) {
      for (let j = i + 1; j < picked.length; j++) {
        const a = picked[i] as string;
        const b = picked[j] as string;
        expect(a.includes(b) || b.includes(a)).toBe(false);
      }
    }
  });
});

describe('调用方传参优先（服务端无模型）', () => {
  const tokenizer = createFallbackTokenizer();
  const messages = [
    { role: 'user', content: '今天股票行情怎么样，新能源和算力选哪个好？' },
    { role: 'assistant', content: '新能源资金流出，算力更强，建议减仓新能源。' },
  ];

  it('card.keywords 覆盖规则结果并做清洗（去重、限长、去单字）', () => {
    const card = composeCard(tokenizer, messages, {
      keywords: ['股票', ' 新能源 ', '股票', 'a', '超长词汇'.repeat(4) + '超出上限'],
      intent: '求推荐',
      importance: 0.9,
    });
    expect(card.keywords).toEqual(['股票', '新能源']);
    expect(card.intent).toBe('求推荐');
    expect(card.importance).toBe(0.9);
  });

  it('调用方未提供关键词时回退规则结果', () => {
    const card = composeCard(tokenizer, messages, { summary: '自定义摘要'.repeat(10) });
    expect(card.keywords.length).toBeGreaterThan(0);
    expect([...card.summary].length).toBeLessThanOrEqual(200);
  });

  it('非法意图被忽略，不影响其它字段', () => {
    const card = composeCard(tokenizer, messages, { intent: '瞎写的意图', keywords: ['股票'] });
    expect(INTENTS).toContain(card.intent);
    expect(card.keywords).toEqual(['股票']);
  });
});

describe('事件卡重复判定与合并', () => {
  const base = {
    id: 1,
    summary: '股票行情与新能源、算力方向的选择讨论：结论是减新能源仓位、优先算力，保留底仓观察。',
    keywords: ['股票行情', '新能源', '算力'],
    intent: '求推荐' as string | null,
    sameSession: true,
  };

  it('同会话同主题判定为追加', () => {
    const decision = decideAppend(base, {
      summary: '继续讨论股票行情：算力方向加到五成仓位，新能源再减一成，底仓保持不变。',
      keywords: ['股票行情', '算力', '仓位'],
      intent: '求推荐',
    });
    expect(decision.append).toBe(true);
    expect(decision.sharedKeywords).toEqual(expect.arrayContaining(['股票行情', '算力']));
    expect(decision.reason).toContain('同会话');
    expect(decision.score).toBeGreaterThan(0);
  });

  it('不同主题判为新建', () => {
    const decision = decideAppend(base, {
      summary: '周末露营装备清单：帐篷、睡袋、炉具与照明，按两天一夜轻量化配置。',
      keywords: ['露营', '装备', '帐篷'],
      intent: '信息同步',
    });
    expect(decision.append).toBe(false);
  });

  it('意图冲突时不合并', () => {
    const decision = decideAppend(base, {
      summary: base.summary,
      keywords: ['股票行情', '新能源', '算力'],
      intent: '排错',
    });
    expect(decision.append).toBe(false);
    expect(decision.reason).toContain('意图');
  });

  it('共享词不足时不合并', () => {
    const decision = decideAppend(
      { ...base, keywords: ['甲', '乙', '丙'], intent: null },
      { summary: base.summary, keywords: ['丁', '戊', '己'], intent: null },
    );
    expect(decision.append).toBe(false);
  });

  it('多候选取相似度最高的一张', () => {
    const picked = pickAppendTarget(
      [
        { id: 2, summary: '无关的数据库迁移记录，涉及备份与回滚演练。', keywords: ['数据库'], intent: null, sameSession: true },
        base,
      ],
      {
        summary: '继续讨论股票行情：算力方向加到五成仓位，新能源再减一成，底仓保持不变。',
        keywords: ['股票行情', '算力', '仓位'],
        intent: '求推荐',
      },
    );
    expect(picked?.candidate.id).toBe(1);
  });

  it('摘要滚动追加：保留原始结论与最近追加，超限丢最旧', () => {
    let summary = '基础结论：该会话围绕部署方案展开，先记录初始决策与约束条件。';
    for (let i = 0; i < 8; i += 1) {
      summary = mergeSummary(summary, `第${i}次追加：补充细节与验证结果。${'x'.repeat(30)}`, 200);
    }
    expect([...summary].length).toBeLessThanOrEqual(200);
    expect(summary).toContain('基础结论');
    expect(summary).toContain('第7次追加');
    expect(summary).not.toContain('第0次追加');
    expect(summary).toContain('追加');
  });

  it('默认上限 200：滚动保留原结论 + 最新一次追加', () => {
    let summary = '基础结论：该会话围绕部署方案展开，先记录初始决策与回滚约束条件。';
    for (let i = 0; i < 12; i += 1) {
      summary = mergeSummary(summary, `第${i}次追加：补充灰度比例、观察指标与回滚演练结果。`);
    }
    expect([...summary].length).toBeLessThanOrEqual(200);
    expect(summary).toContain('基础结论');
    expect(summary).toContain('第11次追加');
    expect(summary).not.toContain('第0次追加');
  });

  it('重复追加同一段内容不会无限膨胀', () => {
    const once = mergeSummary('基础结论：围绕部署方案展开，记录约束条件与回滚策略说明。', '同一段补充说明');
    const twice = mergeSummary(once, '同一段补充说明');
    expect(twice).toBe(once);
  });
});

describe('文本工具', () => {
  it('clampText 不切断代理对', () => {
    const text = '😀😀😀😀';
    expect([...clampText(text, 2)].length).toBeLessThanOrEqual(2);
  });

  it('normalize 归一全角与大小写', () => {
    expect(normalize('ＡＢＣ 股票')).toBe('abc 股票');
  });

  it('diceSimilarity 对同义词给出较高分', () => {
    expect(diceSimilarity('股票', '股市')).toBeGreaterThan(0.4);
    expect(diceSimilarity('股票', '完全不同的词')).toBe(0);
  });

  it('splitSentences 按中英文标点切分', () => {
    expect(splitSentences('第一句。第二句！第三句？')).toEqual(['第一句。', '第二句！', '第三句？']);
  });

  it('uniqueTokens 过滤停用词与单字', () => {
    const tokens = uniqueTokens(['的', '股票', '股票', 'a', '股票行情']);
    expect(tokens).toContain('股票');
    expect(tokens).toContain('股票行情');
    expect(tokens).toEqual(['股票', '股票行情']);
    expect(tokens).not.toContain('的');
    expect(tokens).not.toContain('a');
  });
});

describe('同义扩展（alias fan-out）', () => {
  it('同义邻居按源种子权重打折并入', () => {
    const { weights, added } = expandAliasSeeds(new Map([[1, 1.5]]), [
      { srcId: 1, dstId: 2, name: '大盘' },
    ]);
    expect(weights.get(2)).toBeCloseTo(1.5 * ALIAS_LINK.seedDecay, 6);
    expect(added).toEqual([{ id: 2, name: '大盘' }]);
  });

  it('已在种子里的词不被降权覆盖', () => {
    const { weights, added } = expandAliasSeeds(
      new Map([
        [1, 1.5],
        [2, 1.2],
      ]),
      [{ srcId: 1, dstId: 2, name: '大盘' }],
    );
    expect(weights.get(2)).toBe(1.2);
    expect(added).toHaveLength(0);
  });

  it('每条源种子最多扩 maxNeighbors 个，其余忽略', () => {
    const neighbors = [2, 3, 4, 5].map((dstId) => ({ srcId: 1, dstId, name: `同义词${dstId}` }));
    const { added } = expandAliasSeeds(new Map([[1, 1]]), neighbors, { maxNeighbors: 2 });
    expect(added.map((item) => item.id)).toEqual([2, 3]);
  });

  it('自环与无源权重的边被跳过', () => {
    const { added } = expandAliasSeeds(new Map([[1, 1]]), [
      { srcId: 1, dstId: 1, name: '自己' },
      { srcId: 99, dstId: 7, name: '孤儿' },
    ]);
    expect(added).toHaveLength(0);
  });

  it('同一邻居被多条边指向时只计一次', () => {
    const { weights, added } = expandAliasSeeds(
      new Map([
        [1, 1],
        [2, 1],
      ]),
      [
        { srcId: 1, dstId: 3, name: '共同' },
        { srcId: 2, dstId: 3, name: '共同' },
      ],
    );
    expect(added).toHaveLength(1);
    expect(weights.get(3)).toBeCloseTo(ALIAS_LINK.seedDecay, 6);
  });
});
