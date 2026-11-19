<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ScrollText } from 'lucide-vue-next';
import Badge from '@/components/ui/Badge.vue';
import Card from '@/components/ui/Card.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import Input from '@/components/ui/Input.vue';
import { api, type AuditItem } from '@/lib/api';
import { formatDate } from '@/lib/format';

const objectType = ref('');
const objectId = ref<string>('');

const auditQuery = useQuery({
  queryKey: computed(() => ['audit', { type: objectType.value, id: objectId.value }]),
  queryFn: () =>
    api.audit({
      object_type: objectType.value || undefined,
      object_id: objectId.value ? Number(objectId.value) : undefined,
      limit: 200,
    }),
});

const items = computed<AuditItem[]>(() => auditQuery.data.value ?? []);

const OP_TONE: Record<string, 'default' | 'success' | 'warn' | 'danger' | 'info' | 'outline'> = {
  correct: 'default',
  condense: 'info',
  append: 'info',
  'promote.auto': 'success',
  'promote.manual': 'success',
  'block.pending': 'warn',
  'forget.soft': 'warn',
  'forget.purge': 'danger',
  'forget.skeleton': 'warn',
  evict: 'warn',
  demote: 'warn',
  merge: 'info',
  restore: 'success',
  'restore.purge': 'success',
  reject: 'danger',
  patrol: 'outline',
};

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <div class="space-y-4">
    <Card flush>
      <div class="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <select
          v-model="objectType"
          class="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">全部对象</option>
          <option value="card">card</option>
          <option value="block">block</option>
          <option value="term">term</option>
          <option value="candidate">candidate</option>
          <option value="lifecycle">lifecycle</option>
        </select>
        <Input v-model="objectId" type="number" placeholder="对象 ID" class="h-9 w-32" />
        <span class="ml-auto text-xs text-muted-foreground">{{ items.length }} 条记录</span>
      </div>
    </Card>

    <div v-if="auditQuery.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 6" :key="i" class="h-12 w-full" />
    </div>

    <div v-else-if="auditQuery.isError.value" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
      加载失败：{{ (auditQuery.error.value as Error)?.message }}
    </div>

    <EmptyState
      v-else-if="items.length === 0"
      :icon="ScrollText"
      title="没有审计记录"
      description="所有写入、更正、遗忘、固化、淡忘都会记录操作者与变更前后内容。"
    />

    <Card v-else flush class="overflow-hidden">
      <table class="w-full border-collapse text-sm">
        <thead>
          <tr class="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th class="w-40 px-4 py-2 font-medium">时间</th>
            <th class="w-28 px-2 py-2 font-medium">操作</th>
            <th class="w-32 px-2 py-2 font-medium">对象</th>
            <th class="w-20 px-2 py-2 font-medium">操作者</th>
            <th class="px-2 py-2 font-medium">原因</th>
            <th class="w-16 px-2 py-2 font-medium">变更</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border/50">
          <template v-for="item in items" :key="item.id">
            <tr class="align-top transition-colors hover:bg-accent/30">
              <td class="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                {{ formatDate(item.created_at, true) }}
              </td>
              <td class="px-2 py-2.5">
                <Badge :tone="OP_TONE[item.op] ?? 'secondary'">{{ item.op }}</Badge>
              </td>
              <td class="px-2 py-2.5 text-xs">
                <span class="text-muted-foreground">{{ item.object_type }}</span>
                <span class="ml-1 font-mono">#{{ item.object_id }}</span>
              </td>
              <td class="px-2 py-2.5 text-xs text-muted-foreground">{{ item.actor }}</td>
              <td class="px-2 py-2.5 text-xs leading-relaxed text-muted-foreground">{{ item.reason ?? '—' }}</td>
              <td class="px-2 py-2.5">
                <details class="text-[11px] text-muted-foreground">
                  <summary class="cursor-pointer text-primary hover:underline">展开</summary>
                  <div class="mt-1 grid gap-1.5">
                    <div>
                      <p class="mb-0.5 font-medium text-foreground/70">before</p>
                      <pre class="max-h-40 overflow-auto rounded border border-border/60 bg-muted/30 p-2 leading-relaxed">{{ pretty(item.before) }}</pre>
                    </div>
                    <div>
                      <p class="mb-0.5 font-medium text-foreground/70">after</p>
                      <pre class="max-h-40 overflow-auto rounded border border-border/60 bg-muted/30 p-2 leading-relaxed">{{ pretty(item.after) }}</pre>
                    </div>
                  </div>
                </details>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </Card>
  </div>
</template>
