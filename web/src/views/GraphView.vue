<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { Layers3, Loader2, Maximize2, Network, RotateCcw, Sparkles } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import Card from '@/components/ui/Card.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import RadialGraph from '@/components/RadialGraph.vue';
import { api, type LayeredNode, type RadialGraphPayload } from '@/lib/api';
import { formatDate } from '@/lib/format';

const router = useRouter();

const data = ref<RadialGraphPayload | null>(null);
const selected = ref<LayeredNode | null>(null);
const loading = ref(false);
const initializing = ref(true);
const graphRef = ref<InstanceType<typeof RadialGraph> | null>(null);

// 关键词过滤：出现卡数阈值（页面可设，默认 3）+ 按热度取前 N（0 = 全部）
const minCards = ref(3);
const heatTop = ref(0);

const nodes = computed(() => data.value?.nodes ?? []);
const edges = computed(() => data.value?.edges ?? []);
const countBy = (type: string): number => nodes.value.filter((node) => node.type === type).length;

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api.graphRadial({
      minCards: minCards.value > 0 ? minCards.value : 3,
      heatTop: heatTop.value,
    });
    selected.value = null;
  } catch (err) {
    toast.error('图谱加载失败', { description: (err as Error).message });
  } finally {
    loading.value = false;
    initializing.value = false;
  }
}

function reload(): void {
  void load();
}

function onSelect(node: LayeredNode | null): void {
  selected.value = node;
}

function goCardsByTerm(): void {
  const name = String(selected.value?.meta?.name ?? selected.value?.label ?? '');
  if (name) void router.push({ path: '/cards', query: { term: name } });
}

function goCardDetail(): void {
  const summary = String(selected.value?.meta?.summary ?? '');
  if (summary) void router.push({ path: '/cards', query: { q: summary.slice(0, 12) } });
}

const selectedSummary = computed(() => String(selected.value?.meta?.summary ?? ''));
const selectedKeywords = computed(() => {
  const value = selected.value?.meta?.keywords;
  return Array.isArray(value) ? value.map(String) : [];
});
const selectedTime = computed(() => {
  const value = selected.value?.meta?.created_at ?? selected.value?.meta?.ts;
  return typeof value === 'string' ? value : null;
});

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
    <!-- 画布：主区域 -->
    <Card flush class="relative overflow-hidden">
      <div class="h-[calc(100vh-13rem)] min-h-[520px]">
        <RadialGraph
          v-if="nodes.length > 0"
          ref="graphRef"
          :nodes="nodes"
          :edges="edges"
          :selected-id="selected?.id ?? null"
          @select="onSelect"
        />

        <div v-else-if="initializing" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />加载图谱…
        </div>

        <EmptyState
          v-else
          :icon="Network"
          title="还没有可展示的记忆"
          description="先通过 MCP 的 memory.write 写入几轮对话，事件卡生成后即可在径向图谱里看到全部卡片与关键词。"
        />

        <div class="absolute right-3 top-3 flex flex-col gap-1.5">
          <Button variant="outline" size="sm" title="适应画布" @click="graphRef?.fitView()">
            <Maximize2 class="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" title="重新加载" @click="load">
            <RotateCcw class="h-3.5 w-3.5" />
          </Button>
        </div>

        <div
          v-if="loading"
          class="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-md border border-border/60 bg-background/80 px-2.5 py-1.5 text-[11px] text-muted-foreground backdrop-blur"
        >
          <Loader2 class="h-3 w-3 animate-spin" />加载中…
        </div>
      </div>
    </Card>

    <!-- 侧栏：构成统计与节点详情 -->
    <div class="space-y-3">
      <Card title="构成" description="根 → 关键词 → 记忆卡片；关键词按出现卡数与热度过滤" flush>
        <div class="flex flex-wrap items-center gap-3 border-b border-border/50 px-3 py-2 text-xs">
          <label class="flex items-center gap-1.5 text-muted-foreground">
            词出现卡数 ≥
            <input
              v-model.number="minCards"
              type="number"
              min="1"
              max="100"
              class="h-7 w-16 rounded-md border border-border bg-background px-2 tabular-nums"
              @change="reload"
            />
          </label>
          <select
            v-model.number="heatTop"
            class="h-7 rounded-md border border-border bg-background px-2 text-xs"
            @change="reload"
          >
            <option :value="0">热度：全部</option>
            <option :value="10">热度：前 10</option>
            <option :value="20">热度：前 20</option>
            <option :value="50">热度：前 50</option>
          </select>
        </div>
        <div class="divide-y divide-border/50">
          <div class="flex items-center gap-2 px-3 py-2 text-xs">
            <span class="h-3 w-3 rounded-full" style="background: #a78bfa" />
            <span class="flex-1">L1 常驻（圆心）</span>
            <span class="tabular-nums text-muted-foreground">{{ countBy('l1') }}</span>
          </div>
          <div class="flex items-center gap-2 px-3 py-2 text-xs">
            <span class="h-2.5 w-2.5 rounded-full" style="background: #fbbf24" />
            <span class="flex-1">关键词</span>
            <span class="tabular-nums text-muted-foreground">{{ countBy('term') }}</span>
          </div>
          <div class="flex items-center gap-2 px-3 py-2 text-xs">
            <span class="h-2.5 w-2.5 rounded-full" style="background: #38bdf8" />
            <span class="flex-1">L2 事件卡</span>
            <span class="tabular-nums text-muted-foreground">{{ countBy('card') }}</span>
          </div>
        </div>
        <div class="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
          <p>
            库内：{{ data?.stats.cards ?? 0 }} 卡 · {{ data?.stats.terms ?? 0 }} 词 · {{ data?.stats.raws ?? 0 }} 条原文
          </p>
          <p class="mt-1">L3 原文不进径向图；需要看原文去卡片页详情。</p>
        </div>
      </Card>

      <Card title="选中节点">
        <div v-if="!selected" class="py-4 text-center text-xs text-muted-foreground">
          悬停或点击关键词可高亮相关记忆卡；点击卡查看详情
        </div>
        <div v-else class="space-y-2.5">
          <div class="flex flex-wrap items-center gap-1.5">
            <Badge :tone="selected.type === 'card' ? 'info' : 'warn'">
              {{ selected.type === 'card' ? 'L2 卡' : '关键词' }}
            </Badge>
            <Badge tone="outline">heat {{ selected.heat.toFixed(2) }}</Badge>
            <Badge v-if="selected.meta?.skeleton" tone="info">骨架</Badge>
          </div>

          <p class="text-sm font-medium leading-relaxed">{{ selected.label }}</p>
          <p v-if="selectedSummary" class="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
            {{ selectedSummary }}
          </p>
          <div v-if="selectedKeywords.length > 0" class="flex flex-wrap gap-1">
            <Badge v-for="keyword in selectedKeywords.slice(0, 8)" :key="keyword" tone="outline">{{ keyword }}</Badge>
          </div>
          <p v-if="selectedTime" class="text-[11px] text-muted-foreground">{{ formatDate(selectedTime, true) }}</p>

          <div class="flex flex-wrap gap-2 pt-1">
            <Button v-if="selected.type === 'term'" variant="outline" size="sm" @click="goCardsByTerm">
              <Sparkles class="h-3.5 w-3.5" />查该词记忆
            </Button>
            <Button v-if="selected.type === 'card'" variant="outline" size="sm" @click="goCardDetail">
              <Layers3 class="h-3.5 w-3.5" />去卡片页
            </Button>
          </div>
        </div>
      </Card>

      <p class="text-[11px] leading-relaxed text-muted-foreground">
        链路：根节点 → 关键词 → 记忆卡片。关键词按「出现卡数 ≥ 阈值」与热度过滤，未命中词的卡挂到「其他」节点；共现词用虚线相连，环半径随节点数自适应。节点只是索引投影，不复制数据；根节点选中无效。
      </p>
    </div>
  </div>
</template>
