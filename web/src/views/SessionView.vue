<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import Badge from '@/components/ui/Badge.vue';
import Card from '@/components/ui/Card.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { api } from '@/lib/api';

const previewQuery = useQuery({ queryKey: ['start-preview'], queryFn: api.startPreview });

const blocks = computed(() => previewQuery.data.value?.blocks ?? []);
const used = computed(() => previewQuery.data.value?.budget_used ?? 0);
const maintenance = computed(() => previewQuery.data.value?.maintenance);

const LABEL_TEXT: Record<string, string> = { persona: '人设', rules: '规则', skills: '经验' };

const levelTone = computed<'success' | 'warn' | 'danger'>(() => {
  const level = maintenance.value?.level;
  return level === 'high' ? 'danger' : level === 'medium' ? 'warn' : 'success';
});
const levelText = computed(() => {
  const level = maintenance.value?.level;
  return level === 'high' ? '积压较多' : level === 'medium' ? '略有积压' : '没有积压';
});

function slotText(slot?: string): string {
  if (!slot || slot === 'default') return '通用';
  if (slot === 'index') return '索引';
  return slot;
}
</script>

<template>
  <div class="space-y-4">
    <Card
      title="会话开头会被注入什么"
      description="新会话第一次调用 memory.start 时返回的内容。这里只是预览，不会写入快照，也不影响任何计数。"
      flush
    >
      <div v-if="previewQuery.isPending.value" class="space-y-3 p-4">
        <Skeleton class="h-16 w-full" />
        <Skeleton class="h-10 w-2/3" />
      </div>

      <div
        v-else-if="previewQuery.isError.value"
        class="m-4 rounded-md border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300"
      >
        加载失败：{{ (previewQuery.error.value as Error)?.message }}
      </div>

      <div v-else class="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-xs text-muted-foreground">
        <span>
          共 <span class="tabular-nums text-foreground">{{ blocks.length }}</span> 块
        </span>
        <span>
          占用 <span class="tabular-nums text-foreground">{{ used }}</span> tokens
        </span>
        <span class="flex items-center gap-1.5">
          整理压力
          <Badge :tone="levelTone">{{ levelText }}</Badge>
          <span v-if="maintenance?.hint" class="text-muted-foreground">{{ maintenance.hint }}</span>
        </span>
      </div>
      <div
        v-if="(previewQuery.data.value?.notices?.length ?? 0) > 0"
        class="mx-4 mb-3 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300"
      >
        <p v-for="notice in previewQuery.data.value?.notices" :key="notice">{{ notice }}</p>
      </div>
    </Card>

    <Card
      v-for="(block, index) in blocks"
      :key="`${block.label}-${block.slot ?? 'default'}-${index}`"
      :title="`${LABEL_TEXT[block.label] ?? block.label} · ${slotText(block.slot)}`"
      :description="`${block.tokens} tokens${block.source === 'human' ? ' · 人工维护' : ''}`"
      flush
    >
      <pre
        class="max-h-72 overflow-auto border-t border-border/60 px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground/90"
      >{{ block.text }}</pre>
    </Card>

    <Card
      v-if="previewQuery.data.value?.protocol || previewQuery.data.value?.hook_check"
      title="同时下发给 AI 的附加指令"
      description="人一般不用看，排查行为异常时才对"
      flush
    >
      <div class="space-y-2 px-4 py-3">
        <details
          v-if="previewQuery.data.value?.protocol"
          class="rounded-md border border-border/70 bg-muted/20"
        >
          <summary class="cursor-pointer px-3 py-2 text-xs text-muted-foreground">protocol</summary>
          <pre class="border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">{{ previewQuery.data.value.protocol }}</pre>
        </details>
        <details
          v-if="previewQuery.data.value?.hook_check"
          class="rounded-md border border-border/70 bg-muted/20"
        >
          <summary class="cursor-pointer px-3 py-2 text-xs text-muted-foreground">hook_check</summary>
          <pre class="border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">{{ JSON.stringify(previewQuery.data.value.hook_check, null, 2) }}</pre>
        </details>
      </div>
    </Card>
  </div>
</template>
