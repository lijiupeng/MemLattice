<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Graph } from '@antv/g6';
import type { GraphOptions } from '@antv/g6';
import type { LayeredEdge, LayeredNode } from '@/lib/api';

const props = defineProps<{
  nodes: LayeredNode[];
  edges: LayeredEdge[];
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'select', node: LayeredNode | null): void;
}>();

const container = ref<HTMLDivElement | null>(null);
const graph = shallowRef<Graph | null>(null);

const NODE_STYLE: Record<
  string,
  { fill: string; text: string; size: number; labelMaxWidth: number; fontSize: number; lineHeight: number }
> = {
  l1: { fill: '#a78bfa', text: '#2e1065', size: 104, labelMaxWidth: 86, fontSize: 14, lineHeight: 18 },
  card: { fill: '#38bdf8', text: '#082f49', size: 78, labelMaxWidth: 64, fontSize: 10, lineHeight: 13 },
  term: { fill: '#fbbf24', text: '#451a03', size: 48, labelMaxWidth: 40, fontSize: 11, lineHeight: 14 },
};

const EDGE_STYLE: Record<string, { stroke: string; dash?: number[] }> = {
  holds: { stroke: 'rgba(167,139,250,0.4)' },
  mentions: { stroke: 'rgba(56,189,248,0.35)' },
  co_occur: { stroke: 'rgba(251,191,36,0.4)', dash: [4, 4] },
};

interface G6Datum {
  id?: string | number;
  data?: Record<string, unknown>;
}

function toGraphData() {
  return {
    nodes: props.nodes.map((node) => ({
      id: node.id,
      data: { nodeType: node.type, label: node.label, heat: node.heat },
    })),
    edges: props.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: { type: edge.type, weight: edge.weight },
    })),
  };
}

const NODE_SPACING = 28;

function buildOptions(): GraphOptions {
  return {
    container: container.value as HTMLElement,
    autoFit: false,
    animation: true,
    data: toGraphData(),
    // 官方 concentric 布局：sortBy 按 id 前缀分三环（根 2 / 词 1 / 卡 0，值越大越靠中心）；
    // 每层默认 sweep = 2π(1 - 1/N)，节点均分整圈；半径由 preventOverlap + nodeSize + nodeSpacing 自动算
    layout: {
      type: 'concentric',
      sortBy: (datum?: G6Datum) => {
        const id = String(datum?.id ?? '');
        if (id.startsWith('l1:')) return 2;
        if (id.startsWith('term:')) return 1;
        return 0;
      },
      maxLevelDiff: 0.5,
      preventOverlap: true,
      nodeSize: (datum?: G6Datum) => NODE_STYLE[String(datum?.data?.nodeType)]?.size ?? 48,
      nodeSpacing: NODE_SPACING,
    },
    node: {
      style: {
        size: (datum: G6Datum) => NODE_STYLE[String(datum.data?.nodeType)]?.size ?? 48,
        fill: (datum: G6Datum) => NODE_STYLE[String(datum.data?.nodeType)]?.fill ?? '#94a3b8',
        stroke: '#0b0b0f',
        lineWidth: 2,
        cursor: (datum: G6Datum) => (datum.data?.nodeType === 'l1' ? 'default' : 'pointer'),
        labelText: (datum: G6Datum) => String(datum.data?.label ?? ''),
        labelPlacement: 'center',
        labelWordWrap: true,
        labelMaxWidth: (datum: G6Datum) => NODE_STYLE[String(datum.data?.nodeType)]?.labelMaxWidth ?? 40,
        labelMaxLines: 3,
        labelFontSize: (datum: G6Datum) => NODE_STYLE[String(datum.data?.nodeType)]?.fontSize ?? 11,
        labelLineHeight: (datum: G6Datum) => NODE_STYLE[String(datum.data?.nodeType)]?.lineHeight ?? 14,
        labelFill: (datum: G6Datum) => NODE_STYLE[String(datum.data?.nodeType)]?.text ?? '#e2e8f0',
        labelFontWeight: 500,
        labelBackground: false,
      },
      state: {
        active: { stroke: '#f8fafc', lineWidth: 3, shadowColor: 'rgba(248,250,252,0.4)', shadowBlur: 14 },
        dim: { fillOpacity: 0.14, strokeOpacity: 0.14, labelOpacity: 0.18 },
      },
    },
    edge: {
      type: 'line',
      style: {
        stroke: (datum: G6Datum) => EDGE_STYLE[String(datum.data?.type)]?.stroke ?? 'rgba(148,163,184,0.25)',
        lineDash: (datum: G6Datum) => {
          const value = EDGE_STYLE[String(datum.data?.type)]?.dash;
          return value ? [...value] : undefined;
        },
        lineWidth: (datum: G6Datum) => 0.8 + Math.min(1.6, Number(datum.data?.weight ?? 1) * 0.4),
      },
      state: {
        active: { strokeOpacity: 0.95, lineWidth: 1.8 },
        dim: { strokeOpacity: 0.05 },
      },
    },
    behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
  } as unknown as GraphOptions;
}

function resolveNode(id: string): LayeredNode | null {
  return props.nodes.find((node) => node.id === id) ?? null;
}

/** 与某关键词相关的卡（mentions 指向）与相邻词（共现边） */
function relatedOf(termId: string): { cards: Set<string>; terms: Set<string> } {
  const cards = new Set<string>();
  const terms = new Set<string>();
  for (const edge of props.edges) {
    if (edge.type === 'mentions') {
      if (edge.target === termId) cards.add(edge.source);
      else if (edge.source === termId) cards.add(edge.target);
    } else if (edge.type === 'co_occur') {
      if (edge.source === termId) terms.add(edge.target);
      else if (edge.target === termId) terms.add(edge.source);
    }
  }
  return { cards, terms };
}

let activeTermId: string | null = null;

async function setStates(states: Map<string, string[]>): Promise<void> {
  const instance = graph.value;
  if (!instance) return;
  for (const [id, state] of states) {
    try {
      await instance.setElementState(id, state);
    } catch {
      // 元素可能尚未绘制完成，忽略
    }
  }
}

async function applyHighlight(): Promise<void> {
  const termId = activeTermId ?? (props.selectedId?.startsWith('term:') ? props.selectedId : null);
  if (!termId) {
    const states = new Map<string, string[]>();
    for (const node of props.nodes) states.set(node.id, []);
    for (const edge of props.edges) states.set(edge.id, []);
    return setStates(states);
  }
  const related = relatedOf(termId);
  const activeNodes = new Set<string>([termId, ...related.cards, ...related.terms]);
  const activeEdges = new Set<string>(
    props.edges
      .filter((edge) => (edge.type === 'mentions' || edge.type === 'co_occur') && (edge.source === termId || edge.target === termId))
      .map((edge) => edge.id),
  );
  const states = new Map<string, string[]>();
  for (const node of props.nodes) states.set(node.id, activeNodes.has(node.id) ? ['active'] : ['dim']);
  for (const edge of props.edges) states.set(edge.id, activeEdges.has(edge.id) ? ['active'] : ['dim']);
  return setStates(states);
}

/** 数据变化时重建实例：节点数与环半径都变了，让布局重新计算分环与均分角度。 */
async function mountGraph(): Promise<void> {
  if (!container.value) return;
  graph.value?.destroy();
  graph.value = null;
  activeTermId = null;
  const instance = new Graph(buildOptions());
  instance.on('node:click', (event) => {
    const id = (event as unknown as { target?: { id?: string } }).target?.id;
    const node = id ? resolveNode(String(id)) : null;
    // 根节点选中无效：不进侧栏、不高亮
    if (!node || node.type === 'l1') return;
    emit('select', node);
    void applyHighlight();
  });
  instance.on('canvas:click', () => {
    activeTermId = null;
    emit('select', null);
    void applyHighlight();
  });
  instance.on('node:pointerover', (event) => {
    const id = (event as unknown as { target?: { id?: string } }).target?.id;
    const node = id ? resolveNode(String(id)) : null;
    if (!node || node.type !== 'term') return;
    activeTermId = node.id;
    void applyHighlight();
  });
  instance.on('node:pointerout', () => {
    if (!activeTermId) return;
    activeTermId = null;
    void applyHighlight();
  });
  graph.value = instance;
  await instance.render();
  await instance.fitView();
  await applyHighlight();
}

onMounted(() => {
  void mountGraph();
});

onBeforeUnmount(() => {
  graph.value?.destroy();
  graph.value = null;
});

watch(
  () => [props.nodes, props.edges],
  async () => {
    await mountGraph();
  },
  { deep: false },
);

watch(
  () => props.selectedId,
  async (id) => {
    if (!id) return;
    await graph.value?.focusElement(id, { duration: 300 });
    await applyHighlight();
  },
);

defineExpose({
  fitView: async () => {
    await graph.value?.fitView();
  },
});
</script>

<template>
  <div class="relative h-full w-full">
    <div ref="container" class="h-full w-full" />

    <div
      class="pointer-events-none absolute left-3 top-3 space-y-1 rounded-md border border-border/60 bg-background/75 px-2.5 py-2 text-[11px] text-muted-foreground backdrop-blur"
    >
      <div class="flex items-center gap-1.5"><i class="h-3 w-3 rounded-full" style="background: #a78bfa" />L1 常驻（圆心）</div>
      <div class="flex items-center gap-1.5"><i class="h-2.5 w-2.5 rounded-full" style="background: #fbbf24" />关键词</div>
      <div class="flex items-center gap-1.5"><i class="h-2.5 w-2.5 rounded-full" style="background: #38bdf8" />L2 事件卡</div>
    </div>

    <div class="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border/60 bg-background/75 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
      悬停或选中关键词高亮相关记忆卡 · 可拖拽节点与画布 · 滚轮缩放
    </div>
    <slot />
  </div>
</template>
