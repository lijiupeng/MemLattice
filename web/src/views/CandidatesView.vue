<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Check, Inbox, Loader2, X } from 'lucide-vue-next';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { api, type Candidate } from '@/lib/api';
import { formatDate } from '@/lib/format';

const queryClient = useQueryClient();
const status = ref<'pending' | 'approved' | 'rejected' | 'all'>('pending');

const candidatesQuery = useQuery({
  queryKey: computed(() => ['candidates', status.value]),
  queryFn: () => api.candidates(status.value),
});

const candidates = computed<Candidate[]>(() => candidatesQuery.data.value ?? []);

const approveMutation = useMutation({
  mutationFn: (id: number) => api.approve(id),
  onSuccess: () => {
    toast.success('已写入 L1 经验条目', { description: '可在「常驻层」查看并随时撤销' });
    void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    void queryClient.invalidateQueries({ queryKey: ['blocks'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('批准失败', { description: err.message }),
});

const rejectMutation = useMutation({
  mutationFn: (id: number) => api.reject(id, 'Web 端驳回'),
  onSuccess: () => {
    toast.success('已驳回');
    void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('驳回失败', { description: err.message }),
});

function payloadText(candidate: Candidate): string {
  const content = candidate.payload?.content;
  return typeof content === 'string' ? content : JSON.stringify(candidate.payload);
}

function payloadMeta(candidate: Candidate): string {
  const label = candidate.payload?.label;
  const slot = candidate.payload?.slot;
  const term = candidate.payload?.term_name;
  const intent = candidate.payload?.intent;
  const events = candidate.payload?.events;
  const parts = [
    typeof label === 'string' ? `常驻块：${label}/${typeof slot === 'string' ? slot : 'default'}` : '',
    typeof term === 'string' ? `入口词：${term}` : '',
    typeof intent === 'string' ? `意图：${intent}` : '',
    typeof events === 'number' ? `事件：${events}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

const statusTabs = [
  { value: 'pending', label: '待审' },
  { value: 'approved', label: '已批准' },
  { value: 'rejected', label: '已驳回' },
  { value: 'all', label: '全部' },
] as const;
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex rounded-md border border-border/70 p-0.5">
        <button
          v-for="tab in statusTabs"
          :key="tab.value"
          class="rounded px-2.5 py-1 text-xs transition-colors"
          :class="status === tab.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="status = tab.value"
        >
          {{ tab.label }}
        </button>
      </div>
      <span class="text-xs text-muted-foreground">{{ candidates.length }} 条</span>
      <span class="ml-auto text-[11px] text-muted-foreground">
        批准写入 <code class="rounded bg-muted px-1">skills</code>，≤60 字并携带来源卡指针
      </span>
    </div>

    <div v-if="candidatesQuery.isPending.value" class="space-y-3">
      <Skeleton v-for="i in 3" :key="i" class="h-24 w-full" />
    </div>

    <div v-else-if="candidatesQuery.isError.value" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
      加载失败：{{ (candidatesQuery.error.value as Error)?.message }}
    </div>

    <EmptyState
      v-else-if="candidates.length === 0"
      :icon="Inbox"
      title="队列是空的"
      description="巡检会把「不达固化阈值但已有多事件证据」的经验放进这里，等人工判断是否写入 L1。"
    />

    <div v-else class="space-y-3">
      <Card v-for="candidate in candidates" :key="candidate.id" flush>
        <div class="flex flex-wrap items-start gap-3 p-4">
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <Badge tone="default">{{ candidate.kind }}</Badge>
              <Badge tone="outline">score {{ Number(candidate.score).toFixed(2) }}</Badge>
              <Badge :tone="candidate.status === 'pending' ? 'warn' : candidate.status === 'approved' ? 'success' : 'danger'">
                {{ candidate.status }}
              </Badge>
              <span class="text-[11px] text-muted-foreground">{{ formatDate(candidate.created_at, true) }}</span>
            </div>
            <p class="text-sm leading-relaxed">{{ payloadText(candidate) }}</p>
            <p v-if="payloadMeta(candidate)" class="text-[11px] text-muted-foreground">{{ payloadMeta(candidate) }}</p>
            <p class="text-[11px] text-muted-foreground">
              证据卡：{{ candidate.evidence.length > 0 ? candidate.evidence.join('、') : '无' }}
            </p>
          </div>
          <div v-if="candidate.status === 'pending'" class="flex shrink-0 gap-2">
            <Button
              size="sm"
              :disabled="approveMutation.isPending.value"
              @click="approveMutation.mutate(candidate.id)"
            >
              <Loader2 v-if="approveMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
              <Check v-else class="h-3.5 w-3.5" />
              批准
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="rejectMutation.isPending.value"
              @click="rejectMutation.mutate(candidate.id)"
            >
              <X class="h-3.5 w-3.5" />驳回
            </Button>
          </div>
        </div>
      </Card>
    </div>
  </div>
</template>
