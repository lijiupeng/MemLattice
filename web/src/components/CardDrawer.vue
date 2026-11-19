<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { AlertTriangle, FileText, History, Link2, Loader2, Save, Trash2 } from 'lucide-vue-next';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Textarea from '@/components/ui/Textarea.vue';
import Badge from '@/components/ui/Badge.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { api } from '@/lib/api';
import { INTENTS, formatDate, kindLabel, relativeTime } from '@/lib/format';

const props = defineProps<{ open: boolean; cardId: number | null }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const queryClient = useQueryClient();
const purgeOpen = ref(false);
const purgePhrase = ref('');

const detailQuery = useQuery({
  queryKey: computed(() => ['card', props.cardId]),
  queryFn: () => api.card(props.cardId as number),
  enabled: computed(() => props.open && props.cardId !== null),
});

const form = reactive({
  summary: '',
  intent: '',
  keywords: '',
  entities: '',
  importance: 0.5,
});

watch(
  () => detailQuery.data.value,
  (data) => {
    if (!data) return;
    form.summary = data.card.summary;
    form.intent = data.card.intent ?? '';
    form.keywords = (data.card.keywords ?? []).join('，');
    form.entities = (data.card.entities ?? []).join('，');
    form.importance = Number(data.card.importance ?? 0.5);
  },
  { immediate: true },
);

const summaryLength = computed(() => [...form.summary].length);
const summaryValid = computed(() => summaryLength.value >= 40 && summaryLength.value <= 600);
const dirty = computed(() => {
  const data = detailQuery.data.value;
  if (!data) return false;
  return (
    form.summary !== data.card.summary ||
    form.intent !== (data.card.intent ?? '') ||
    form.keywords !== (data.card.keywords ?? []).join('，') ||
    form.entities !== (data.card.entities ?? []).join('，') ||
    Math.abs(form.importance - Number(data.card.importance ?? 0.5)) > 0.001
  );
});

function splitList(value: string): string[] {
  return value
    .split(/[，,、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const saveMutation = useMutation({
  mutationFn: () =>
    api.patchCard(props.cardId as number, {
      summary: form.summary.trim(),
      intent: form.intent || null,
      keywords: splitList(form.keywords),
      entities: splitList(form.entities),
      importance: form.importance,
      reason: 'Web 端编辑',
    }),
  onSuccess: () => {
    toast.success('已保存，版本已递增');
    void queryClient.invalidateQueries({ queryKey: ['card', props.cardId] });
    void queryClient.invalidateQueries({ queryKey: ['cards'] });
    void queryClient.invalidateQueries({ queryKey: ['audit'] });
  },
  onError: (err: Error) => toast.error('保存失败', { description: err.message }),
});

const softDeleteMutation = useMutation({
  mutationFn: () => api.deleteCard(props.cardId as number, 'soft'),
  onSuccess: () => {
    toast.success('已移入回收站', { description: '7 天内可在回收站恢复' });
    emit('update:open', false);
    void queryClient.invalidateQueries({ queryKey: ['cards'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('操作失败', { description: err.message }),
});

const purgeMutation = useMutation({
  mutationFn: () => api.deleteCard(props.cardId as number, 'purge', true),
  onSuccess: () => {
    purgeOpen.value = false;
    purgePhrase.value = '';
    toast.success('已物理清除', { description: '快照保留在回收站 7 天' });
    emit('update:open', false);
    void queryClient.invalidateQueries({ queryKey: ['cards'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('清除失败', { description: err.message }),
});

const feedbackMutation = useMutation({
  mutationFn: (verdict: 'wrong' | 'irrelevant' | 'helpful') =>
    api.feedbackCard(props.cardId as number, verdict),
  onSuccess: (data) => {
    toast.success(
      data.verdict === 'wrong'
        ? `已记为有误，置信度降到 ${data.confidence.toFixed(2)}`
        : data.verdict === 'irrelevant'
          ? '已记为无关，排序会往下压'
          : '已记为有用，热度 +1',
    );
    void queryClient.invalidateQueries({ queryKey: ['card', props.cardId] });
    void queryClient.invalidateQueries({ queryKey: ['cards'] });
  },
  onError: (err: Error) => toast.error('反馈失败', { description: err.message }),
});

const card = computed(() => detailQuery.data.value?.card ?? null);
const isSkeleton = computed(() => Boolean(card.value?.is_skeleton));
const confidence = computed(() => Number(card.value?.confidence ?? 0.8));
const useCount = computed(() => Number(card.value?.use_count ?? 0));
const hitCount = computed(() => Number(card.value?.hit_count ?? 0));
/** 曝光不足 3 次时比率没有意义，1/1 会被读成 100% */
const precision = computed(() =>
  hitCount.value < 3 ? null : Math.round((useCount.value / hitCount.value) * 100),
);
const confidenceTone = computed<'success' | 'warn' | 'danger'>(() =>
  confidence.value < 0.3 ? 'danger' : confidence.value < 0.6 ? 'warn' : 'success',
);

/** seq 只在事件内有意义，所以按事件分段渲染，段内才看得到真实顺序 */
type RawRefItem = {
  raw_id: number;
  seq: number;
  role: string;
  content: string;
  ts: string;
  archived: boolean;
  event_id: number;
};

const rawGroups = computed(() => {
  const groups: Array<{
    eventId: number;
    startedAt: string | null;
    sessionId: string | null;
    items: RawRefItem[];
  }> = [];
  for (const raw of detailQuery.data.value?.raw_refs ?? []) {
    const last = groups[groups.length - 1];
    if (last && last.eventId === raw.event_id) last.items.push(raw);
    else
      groups.push({
        eventId: raw.event_id,
        startedAt: raw.event_started_at,
        sessionId: raw.session_id,
        items: [raw],
      });
  }
  return groups;
});
</script>

<template>
  <Dialog
    :open="props.open"
    :title="card ? `卡 #${card.id}` : '事件卡'"
    :description="card ? `${card.intent ?? '未标意图'} · 热度 ${Number(card.heat).toFixed(2)} · v${card.version}` : '加载中'"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="detailQuery.isPending.value" class="space-y-3">
      <Skeleton class="h-24 w-full" />
      <Skeleton class="h-10 w-2/3" />
      <Skeleton class="h-32 w-full" />
    </div>

    <div v-else-if="detailQuery.isError.value" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
      加载失败：{{ (detailQuery.error.value as Error)?.message }}
    </div>

    <div v-else-if="card" class="space-y-5">
      <div v-if="isSkeleton" class="flex gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-xs leading-relaxed text-sky-300">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>该卡已淡忘为骨架卡：摘要已压缩，且不再持有 L3 原文引用。如需细节请通过其它入口追溯。</span>
      </div>

      <!-- 记忆质量：这张卡值不值得信，以及人给它的评价 -->
      <section class="rounded-md border border-border/70 bg-muted/20 p-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          <span class="text-xs font-semibold uppercase tracking-wide">记忆质量</span>
          <Badge :tone="confidenceTone">置信度 {{ confidence.toFixed(2) }}</Badge>
          <span>被采用 <span class="tabular-nums text-foreground">{{ useCount }}</span> 次</span>
          <span>被检索 <span class="tabular-nums text-foreground">{{ hitCount }}</span> 次</span>
          <span v-if="precision !== null">
            采用率 <span class="tabular-nums text-foreground">{{ precision }}%</span>
          </span>
          <span v-else>样本太少，暂不算采用率</span>
        </div>
        <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            :disabled="feedbackMutation.isPending.value"
            @click="feedbackMutation.mutate('helpful')"
          >
            用上了
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="feedbackMutation.isPending.value"
            @click="feedbackMutation.mutate('irrelevant')"
          >
            无关
          </Button>
          <Button
            size="sm"
            variant="outline"
            class="text-rose-300 hover:text-rose-200"
            :disabled="feedbackMutation.isPending.value"
            @click="feedbackMutation.mutate('wrong')"
          >
            有误
          </Button>
          <span class="ml-auto text-[11px] text-muted-foreground">表态会写审计</span>
        </div>
      </section>

      <!-- 编辑 -->
      <section class="space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">摘要</h3>
          <span
            class="text-[11px] tabular-nums"
            :class="summaryValid ? 'text-muted-foreground' : 'text-rose-400'"
          >
            {{ summaryLength }} / 600（需 40–600）
          </span>
        </div>
        <Textarea v-model="form.summary" :rows="5" placeholder="只留结论与可回指的锚点，不记原文细节" />

        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-muted-foreground">意图</label>
            <select
              v-model="form.intent"
              class="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <option value="">未标记</option>
              <option v-for="item in INTENTS" :key="item" :value="item">{{ item }}</option>
            </select>
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-muted-foreground">重要度（0–1）</label>
            <div class="flex h-9 items-center gap-2 rounded-md border border-input px-3">
              <input
                v-model.number="form.importance"
                type="range"
                min="0"
                max="1"
                step="0.05"
                class="h-1 flex-1 accent-[var(--color-primary)]"
              />
              <span class="w-8 text-right text-xs tabular-nums">{{ form.importance.toFixed(2) }}</span>
            </div>
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-muted-foreground">关键词（逗号分隔，最多 3 个）</label>
            <Input v-model="form.keywords" placeholder="浓缩全篇的主题词，如：股票，Kubernetes，阿澜" />
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-muted-foreground">实体</label>
            <Input v-model="form.entities" placeholder="公司名、产品名等" />
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Button size="sm" :disabled="!dirty || !summaryValid || saveMutation.isPending.value" @click="saveMutation.mutate()">
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
            <Save v-else class="h-3.5 w-3.5" />
            保存修改
          </Button>
          <span v-if="dirty" class="text-[11px] text-amber-400">有未保存的修改</span>
          <span class="ml-auto text-[11px] text-muted-foreground">创建于 {{ formatDate(card.created_at, true) }}</span>
        </div>
      </section>

      <!-- 关联词 -->
      <section class="space-y-2">
        <h3 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Link2 class="h-3.5 w-3.5" />关联词
        </h3>
        <div class="flex flex-wrap gap-1.5">
          <Badge v-for="t in detailQuery.data.value?.terms" :key="`${t.id}-${t.role}`" tone="outline">
            {{ t.name }} · {{ kindLabel(t.kind) }}
          </Badge>
          <span v-if="(detailQuery.data.value?.terms?.length ?? 0) === 0" class="text-xs text-muted-foreground">
            该卡尚未挂载词节点（索引失败时会退化到关键词匹配）
          </span>
        </div>
      </section>

      <!-- 原文引用 -->
      <section class="space-y-2">
        <h3 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileText class="h-3.5 w-3.5" />L3 原文引用
          <span class="font-normal normal-case">
            （{{ detailQuery.data.value?.raw_refs.length ?? 0 }} 条 · {{ rawGroups.length }} 个事件）
          </span>
        </h3>
        <div v-if="rawGroups.length === 0" class="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          {{ isSkeleton ? '骨架卡不持有原文引用' : '没有关联的明细记录' }}
        </div>
        <div v-for="(group, gi) in rawGroups" :key="group.eventId" class="space-y-1.5">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span class="font-medium text-foreground">第 {{ gi + 1 }} 段</span>
            <span v-if="group.startedAt">{{ formatDate(group.startedAt, true) }}</span>
            <span v-if="group.sessionId" class="max-w-[12rem] truncate">场景 {{ group.sessionId }}</span>
            <span class="tabular-nums">{{ group.items.length }} 条</span>
          </div>
          <div class="space-y-1.5 border-l border-border/70 pl-2.5">
            <details
              v-for="raw in group.items"
              :key="raw.raw_id"
              class="group rounded-md border border-border/70 bg-muted/20"
            >
              <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <span class="font-mono">#{{ raw.seq }}</span>
                <span class="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">{{ raw.role }}</span>
                <span class="truncate">{{ raw.content.slice(0, 48) }}</span>
                <Badge v-if="raw.archived" tone="info" class="ml-auto">归档</Badge>
                <span class="ml-auto whitespace-nowrap">{{ relativeTime(raw.ts) }}</span>
              </summary>
              <pre class="max-h-56 overflow-auto border-t border-border/60 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words">{{ raw.content }}</pre>
            </details>
          </div>
        </div>
      </section>

      <!-- 版本 -->
      <section v-if="(detailQuery.data.value?.versions.length ?? 0) > 0" class="space-y-2">
        <h3 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <History class="h-3.5 w-3.5" />版本历史
        </h3>
        <div class="space-y-1.5">
          <details
            v-for="version in detailQuery.data.value?.versions"
            :key="version.version"
            class="rounded-md border border-border/70"
          >
            <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <span class="font-medium text-foreground">v{{ version.version }}</span>
              <span>{{ version.actor }}</span>
              <span class="ml-auto">{{ formatDate(version.created_at, true) }}</span>
            </summary>
            <pre class="max-h-40 overflow-auto border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed">{{ JSON.stringify(version.snapshot, null, 2) }}</pre>
          </details>
        </div>
      </section>

      <!-- 危险操作 -->
      <section class="space-y-2 rounded-md border border-rose-500/25 bg-rose-500/5 p-3">
        <p class="text-xs font-medium text-rose-300">遗忘</p>
        <p class="text-[11px] leading-relaxed text-muted-foreground">
          软删只是不再出现在检索结果里，7 天内可恢复；物理清除不可恢复，会先落回收站快照。
        </p>
        <div class="flex flex-wrap gap-2 pt-1">
          <Button variant="outline" size="sm" :disabled="softDeleteMutation.isPending.value" @click="softDeleteMutation.mutate()">
            <Trash2 class="h-3.5 w-3.5" />软删
          </Button>
          <Button variant="destructive" size="sm" @click="purgeOpen = true">物理清除</Button>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-muted-foreground">
          {{ card ? `事件 #${card.id} · ${card.category === 'person' ? '人物关系类' : '常规'} · ${card.source}` : '' }}
        </span>
        <Button variant="ghost" @click="emit('update:open', false)">关闭</Button>
      </div>
    </template>
  </Dialog>

  <Dialog v-model:open="purgeOpen" title="物理清除确认" description="清除后只能从回收站快照恢复，7 天后不可逆" class="max-w-md">
    <div class="space-y-3">
      <p class="text-xs leading-relaxed text-muted-foreground">
        请输入「<span class="font-mono text-foreground">清除</span>」以确认物理清除卡片
        <span class="font-mono text-foreground">#{{ props.cardId }}</span>。
      </p>
      <Input v-model="purgePhrase" placeholder="清除" />
    </div>
    <template #footer>
      <div class="flex justify-end gap-2">
        <Button variant="ghost" @click="purgeOpen = false">取消</Button>
        <Button variant="destructive" :disabled="purgePhrase !== '清除' || purgeMutation.isPending.value" @click="purgeMutation.mutate()">
          确认清除
        </Button>
      </div>
    </template>
  </Dialog>
</template>
