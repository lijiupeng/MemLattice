<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { ChevronRight, Layers, RotateCcw, Search } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Badge from '@/components/ui/Badge.vue';
import Card from '@/components/ui/Card.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import CardDrawer from '@/components/CardDrawer.vue';
import { api } from '@/lib/api';
import { INTENTS, formatDate } from '@/lib/format';

const route = useRoute();

const q = ref(String(route.query.q ?? ''));
const term = ref(String(route.query.term ?? ''));
const intent = ref('');
const stale = ref(false);
const includeSkeleton = ref(false);
const page = ref(1);
const selectedId = ref<number | null>(null);
const drawerOpen = ref(false);

const debouncedQ = ref(q.value);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(q, (value) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    debouncedQ.value = value;
    page.value = 1;
  }, 300);
});
watch([term, intent, stale, includeSkeleton], () => {
  page.value = 1;
});

const cardsQuery = useQuery({
  queryKey: computed(() => [
    'cards',
    {
      q: debouncedQ.value,
      term: term.value,
      intent: intent.value,
      stale: stale.value,
      skeleton: includeSkeleton.value,
      page: page.value,
    },
  ]),
  queryFn: () =>
    api.cards({
      q: debouncedQ.value || undefined,
      term: term.value || undefined,
      intent: intent.value || undefined,
      stale: stale.value || undefined,
      include_skeleton: includeSkeleton.value || undefined,
      page: page.value,
      page_size: 20,
    }),
  placeholderData: keepPreviousData,
});

const items = computed(() => cardsQuery.data.value?.items ?? []);
const total = computed(() => cardsQuery.data.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / 20)));

const heatMax = computed(() => Math.max(1, ...items.value.map((item) => item.heat)));

const hasFilter = computed(
  () => Boolean(q.value || term.value || intent.value || stale.value || includeSkeleton.value),
);

function resetFilters(): void {
  q.value = '';
  term.value = '';
  intent.value = '';
  stale.value = false;
  includeSkeleton.value = false;
  page.value = 1;
}

function openCard(id: number): void {
  selectedId.value = id;
  drawerOpen.value = true;
}

function heatWidth(heat: number): string {
  return `${Math.max(4, Math.min(100, (heat / heatMax.value) * 100))}%`;
}
</script>

<template>
  <div class="space-y-4">
    <!-- 筛选：次级区域，服务于列表这个主区域 -->
    <Card flush>
      <div class="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div class="relative min-w-[200px] flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="q" placeholder="搜索摘要、关键词、实体" class="h-9 pl-8" />
        </div>
        <Input v-model="term" placeholder="入口词 / term" class="h-9 w-40" />
        <select
          v-model="intent"
          class="h-9 rounded-md border border-input bg-transparent px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">全部意图</option>
          <option v-for="item in INTENTS" :key="item" :value="item">{{ item }}</option>
        </select>
        <label class="flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground">
          <input v-model="stale" type="checkbox" class="size-3.5 accent-[var(--color-primary)]" />
          只看 stale
        </label>
        <label class="flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground">
          <input v-model="includeSkeleton" type="checkbox" class="size-3.5 accent-[var(--color-primary)]" />
          含骨架卡
        </label>
        <Button v-if="hasFilter" variant="ghost" size="sm" @click="resetFilters">
          <RotateCcw class="h-3.5 w-3.5" />
          重置
        </Button>
        <span class="ml-auto text-xs text-muted-foreground">
          共 <span class="tabular-nums text-foreground">{{ total }}</span> 张
        </span>
      </div>
    </Card>

    <!-- 错误状态 -->
    <div
      v-if="cardsQuery.isError.value"
      class="flex flex-wrap items-center gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300"
    >
      <span>加载失败：{{ (cardsQuery.error.value as Error)?.message }}</span>
      <Button variant="outline" size="sm" class="ml-auto" @click="cardsQuery.refetch()">重试</Button>
    </div>

    <!-- 列表：主区域 -->
    <Card flush class="overflow-hidden">
      <div v-if="cardsQuery.isPending.value" class="divide-y divide-border/60">
        <div v-for="i in 6" :key="i" class="flex items-center gap-4 px-4 py-3.5">
          <Skeleton class="h-10 flex-1" />
          <Skeleton class="hidden h-4 w-16 sm:block" />
          <Skeleton class="h-4 w-12" />
        </div>
      </div>

      <EmptyState
        v-else-if="items.length === 0"
        :icon="Layers"
        :title="hasFilter ? '没有匹配的记忆' : '还没有事件卡'"
        :description="
          hasFilter
            ? '换个检索词，或清空筛选条件。冷记忆默认沉底，也不会出现在检索结果里。'
            : '通过 MCP 的 memory.write 写入对话，事件结束（close=true）或达到轮次阈值后会自动浓缩成 L2 事件卡。'
        "
      >
        <Button v-if="hasFilter" variant="outline" size="sm" @click="resetFilters">清空筛选</Button>
      </EmptyState>

      <table v-else class="w-full border-collapse text-sm">
        <thead>
          <tr class="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th class="px-4 py-2 font-medium">摘要</th>
            <th class="hidden w-28 px-2 py-2 font-medium md:table-cell">意图</th>
            <th class="hidden w-24 px-2 py-2 font-medium lg:table-cell">热度</th>
            <th class="w-28 px-2 py-2 font-medium">状态</th>
            <th class="hidden w-28 px-2 py-2 font-medium sm:table-cell">时间</th>
            <th class="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody class="divide-y divide-border/50">
          <tr
            v-for="item in items"
            :key="item.id"
            class="cursor-pointer transition-colors hover:bg-accent/40"
            @click="openCard(item.id)"
          >
            <td class="px-4 py-3 align-top">
              <p class="line-clamp-2 max-w-3xl leading-relaxed text-foreground/90">{{ item.summary }}</p>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Badge v-for="kw in item.keywords.slice(0, 5)" :key="kw" tone="outline">{{ kw }}</Badge>
                <span v-if="item.keywords.length > 5" class="text-[11px] text-muted-foreground">
                  +{{ item.keywords.length - 5 }}
                </span>
              </div>
            </td>
            <td class="hidden px-2 py-3 align-top md:table-cell">
              <Badge v-if="item.intent" tone="default">{{ item.intent }}</Badge>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </td>
            <td class="hidden px-2 py-3 align-top lg:table-cell">
              <div class="flex items-center gap-2">
                <div class="h-1 w-12 overflow-hidden rounded-full bg-muted">
                  <div class="h-full rounded-full bg-primary/70" :style="{ width: heatWidth(item.heat) }" />
                </div>
                <span class="text-[11px] tabular-nums text-muted-foreground">{{ item.heat.toFixed(2) }}</span>
              </div>
            </td>
            <td class="px-2 py-3 align-top">
              <div class="flex flex-wrap gap-1">
                <Badge v-if="Number(item.confidence) < 0.3" tone="danger">存疑</Badge>
                <Badge v-if="item.stale" tone="warn">stale</Badge>
                <Badge v-if="item.is_skeleton" tone="info">骨架</Badge>
                <Badge v-if="item.source === 'external'" tone="danger">外部</Badge>
                <Badge v-if="!item.stale && !item.is_skeleton && item.source !== 'external'" tone="success">
                  v{{ item.version }}
                </Badge>
              </div>
            </td>
            <td class="hidden px-2 py-3 align-top text-xs text-muted-foreground sm:table-cell">
              {{ formatDate(item.created_at) }}
            </td>
            <td class="px-2 py-3 align-top">
              <ChevronRight class="h-4 w-4 text-muted-foreground/60" />
            </td>
          </tr>
        </tbody>
      </table>

      <div
        v-if="items.length > 0"
        class="flex items-center justify-between border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground"
      >
        <span>第 {{ page }} / {{ totalPages }} 页 · 按热度排序</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="page <= 1" @click="page -= 1">上一页</Button>
          <Button variant="outline" size="sm" :disabled="page >= totalPages" @click="page += 1">下一页</Button>
        </div>
      </div>
    </Card>

    <CardDrawer v-model:open="drawerOpen" :card-id="selectedId" />
  </div>
</template>
