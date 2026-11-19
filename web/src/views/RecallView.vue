<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { AlertTriangle, Gauge, Loader2, Sparkles } from 'lucide-vue-next';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Input from '@/components/ui/Input.vue';
import Textarea from '@/components/ui/Textarea.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { api, type RecallPayload } from '@/lib/api';

const query = ref('');
const budget = ref(2200);
const includeWeak = ref(true);
const scope = ref<'all' | 'project' | 'person'>('all');
const result = ref<RecallPayload | null>(null);

const runMutation = useMutation({
  mutationFn: () =>
    api.recall({
      query: query.value.trim(),
      budget_tokens: budget.value,
      include_weak: includeWeak.value,
      scope: scope.value,
      // 预览页需要看到 dropped / trace 明细
      debug: true,
    }),
  onSuccess: (data) => {
    result.value = data;
  },
  onError: (err: Error) => toast.error('检索失败', { description: err.message }),
});

const usedRatio = computed(() => {
  if (!result.value) return 0;
  return result.value.budget_used / Math.max(1, result.value.budget_limit);
});

const barTone = computed(() => {
  if (usedRatio.value >= 0.95) return 'bg-rose-400';
  if (usedRatio.value >= 0.8) return 'bg-amber-400';
  return 'bg-emerald-400';
});

const cardTokens = computed(() => result.value?.cards.reduce((sum, card) => sum + card.tokens, 0) ?? 0);

function run(): void {
  if (!query.value.trim()) {
    toast.warning('请输入查询语句');
    return;
  }
  runMutation.mutate();
}

const presets = [400, 600, 1200, 2000];
</script>

<template>
  <div class="space-y-4">
    <!-- 输入 -->
    <Card title="试试它会想起什么" description="输入一句话，看命中哪些记忆、各占多少预算">
      <div class="space-y-3">
        <Textarea
          v-model="query"
          :rows="2"
          placeholder="例如：今天股票行情怎么样，新能源和算力选哪个好？"
          @keyup.ctrl.enter="run"
        />
        <div class="flex flex-wrap items-end gap-3">
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-muted-foreground">预算（tokens）</label>
            <div class="flex items-center gap-1.5">
              <Button
                v-for="preset in presets"
                :key="preset"
                :variant="budget === preset ? 'default' : 'outline'"
                size="sm"
                @click="budget = preset"
              >
                {{ preset }}
              </Button>
              <Input
                :model-value="budget"
                type="number"
                :min="200"
                :max="4000"
                class="w-24"
                @update:model-value="(value) => (budget = Number(value) || 200)"
              />
            </div>
          </div>
          <div class="space-y-1.5">
            <label class="text-[11px] font-medium text-muted-foreground">范围</label>
            <select
              v-model="scope"
              class="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <option value="all">全部</option>
              <option value="project">常规（非人物）</option>
              <option value="person">人物关系</option>
            </select>
          </div>
          <label class="flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground">
            <input v-model="includeWeak" type="checkbox" class="size-3.5 accent-[var(--color-primary)]" />
            返回弱关联提示
          </label>
          <Button class="ml-auto" :disabled="runMutation.isPending.value" @click="run">
            <Loader2 v-if="runMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
            <Sparkles v-else class="h-3.5 w-3.5" />
            开始检索
          </Button>
        </div>
      </div>
    </Card>

    <EmptyState
      v-if="!result"
      :icon="Gauge"
      title="还没有检索结果"
      description="输入一句真实的话，看系统会想起哪些事：强关联的会整段带进来，弱关联只留一行提示。"
    />

    <template v-else>
      <!-- 预算条 -->
      <Card flush>
        <div class="space-y-3 p-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between text-xs">
                <span class="font-medium">注入预算</span>
                <span class="tabular-nums text-muted-foreground">
                  {{ result.budget_used }} / {{ result.budget_limit }} tokens
                  <span class="ml-1">({{ Math.round(usedRatio * 100) }}%)</span>
                </span>
              </div>
              <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
                <div class="h-full rounded-full transition-all" :class="barTone" :style="{ width: `${Math.min(100, usedRatio * 100)}%` }" />
              </div>
            </div>
            <div class="flex flex-wrap gap-1.5 text-[11px]">
              <Badge tone="outline">常驻内容见「会话预览」</Badge>
              <Badge tone="success">卡 {{ result.cards.length }}（{{ cardTokens }} tok）</Badge>
              <Badge tone="warn">提示 {{ result.hints.length }}（不占预算）</Badge>
              <Badge tone="danger">丢弃 {{ result.dropped_count }}</Badge>
              <Badge v-if="result.truncated" tone="warn">已截断</Badge>
              <Badge tone="secondary">{{ result.trace?.elapsed_ms ?? 0 }} ms</Badge>
            </div>
          </div>
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            <template v-if="result.injection_order">注入顺序：{{ result.injection_order.join(' → ') }}。</template>
            {{ result.note }}
          </p>
        </div>
      </Card>

      <div class="space-y-4">
        <!-- 强关联卡 -->
        <Card title="强关联事件卡" description="PPR ≥0.30、30 天内、重合词 ≥2 才直接注入" flush>
          <div v-if="result.cards.length === 0" class="px-4 py-8 text-center text-xs text-muted-foreground">
            本次没有强关联卡（可能只有弱关联，见下方提示）
          </div>
          <div v-else class="divide-y divide-border/50">
            <div v-for="card in result.cards" :key="card.id" class="px-4 py-3">
              <div class="mb-1 flex flex-wrap items-center gap-1.5">
                <span class="font-mono text-[11px] text-muted-foreground">#{{ card.id }}</span>
                <Badge v-if="card.intent" tone="default">{{ card.intent }}</Badge>
                <Badge v-if="card.stale" tone="warn">stale</Badge>
                <Badge v-if="card.skeleton" tone="info">骨架</Badge>
                <span class="ml-auto text-[11px] tabular-nums text-muted-foreground">
                  score {{ card.score.toFixed(3) }} · {{ card.tokens }} tok
                </span>
              </div>
              <p class="text-xs leading-relaxed text-foreground/85">{{ card.summary }}</p>
            </div>
          </div>
        </Card>
      </div>

      <div class="grid gap-4 xl:grid-cols-2">
        <!-- 弱关联提示 -->
        <Card title="弱关联提示" description="只输出一行提示，不占上下文预算">
          <div v-if="result.hints.length === 0" class="py-4 text-center text-xs text-muted-foreground">
            本次没有弱关联提示
          </div>
          <ul v-else class="space-y-2">
            <li
              v-for="hint in result.hints"
              :key="hint.card_id"
              class="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs leading-relaxed"
            >
              <span class="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              <span>{{ hint.text }}</span>
            </li>
          </ul>
        </Card>

        <!-- 丢弃与 L1.5 -->
        <Card title="丢弃明细与滚动索引" description="超限裁剪可审计；L1.5 置于 prompt 末尾">
          <div class="space-y-3">
            <div v-if="result.dropped.length > 0" class="flex flex-wrap gap-1.5">
              <Badge v-for="item in result.dropped" :key="`${item.key}-${item.reason}`" :tone="item.reason === 'cold' ? 'info' : 'danger'">
                {{ item.key }} · {{ item.reason === 'cold' ? '冷记忆' : `${item.tokens} tok` }}
              </Badge>
            </div>
            <p v-else class="text-xs text-muted-foreground">没有条目被裁剪</p>

            <div class="rounded-md border border-border/60 bg-muted/20 p-3">
              <p class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <AlertTriangle class="h-3 w-3" />L1.5 最近事件索引（{{ result.recent_index.length }} 条）
              </p>
              <ul class="space-y-1 text-xs text-foreground/80">
                <li v-for="item in result.recent_index" :key="item.event_id">
                  事件 #{{ item.event_id }} · {{ item.keywords.join('、') || '（无关键词）' }}
                </li>
                <li v-if="result.recent_index.length === 0" class="text-muted-foreground">无</li>
              </ul>
            </div>

            <div v-if="result.trace?.seeds?.length" class="text-[11px] text-muted-foreground">
              种子词：{{ result.trace?.seeds?.map((s) => s.name).join('、') }}
            </div>
          </div>
        </Card>
      </div>
    </template>
  </div>
</template>
