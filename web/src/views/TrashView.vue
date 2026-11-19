<script setup lang="ts">
import { computed } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Loader2, RotateCcw, Trash2 } from 'lucide-vue-next';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { api, type TrashItem } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';

const queryClient = useQueryClient();
const trashQuery = useQuery({ queryKey: ['trash'], queryFn: api.trash });

const items = computed<TrashItem[]>(() => trashQuery.data.value ?? []);
const softItems = computed(() => items.value.filter((item) => item.kind === 'soft'));
const snapshotItems = computed(() => items.value.filter((item) => item.kind === 'snapshot'));

const restoreMutation = useMutation({
  mutationFn: (item: TrashItem) =>
    item.kind === 'soft' ? api.restoreSoft(item.object_type, item.object_id) : api.restoreSnapshot(item.id),
  onSuccess: () => {
    toast.success('已恢复');
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['cards'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('恢复失败', { description: err.message }),
});

function daysLeft(purgeAt?: string): string {
  if (!purgeAt) return '—';
  const diff = new Date(purgeAt).getTime() - Date.now();
  if (diff <= 0) return '已到期';
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="trashQuery.isPending.value" class="space-y-3">
      <Skeleton v-for="i in 3" :key="i" class="h-20 w-full" />
    </div>

    <div v-else-if="trashQuery.isError.value" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
      加载失败：{{ (trashQuery.error.value as Error)?.message }}
    </div>

    <template v-else>
      <Card title="软删（可随时恢复）" description="不再出现在检索结果里，但数据还在" flush>
        <template #actions>
          <Badge tone="outline">{{ softItems.length }}</Badge>
        </template>
        <div v-if="softItems.length === 0" class="px-4 py-8">
          <EmptyState :icon="Trash2" title="没有软删的对象" description="在记忆卡片详情里点「软删」会进入这里。" />
        </div>
        <div v-else class="divide-y divide-border/50">
          <div v-for="item in softItems" :key="`${item.object_type}-${item.object_id}`" class="flex items-center gap-3 px-4 py-3">
            <Badge tone="outline">{{ item.object_type }}</Badge>
            <p class="min-w-0 flex-1 truncate text-sm">{{ item.title }}</p>
            <span class="whitespace-nowrap text-[11px] text-muted-foreground">{{ relativeTime(item.created_at) }} 删除</span>
            <Button variant="outline" size="sm" :disabled="restoreMutation.isPending.value" @click="restoreMutation.mutate(item)">
              <RotateCcw class="h-3.5 w-3.5" />恢复
            </Button>
          </div>
        </div>
      </Card>

      <Card title="物理清除快照" description="清除前的完整快照，7 天内可回灌恢复" flush>
        <template #actions>
          <Badge :tone="snapshotItems.length > 0 ? 'warn' : 'outline'">{{ snapshotItems.length }}</Badge>
        </template>
        <div v-if="snapshotItems.length === 0" class="px-4 py-8">
          <EmptyState
            :icon="Trash2"
            title="没有待清除快照"
            description="物理清除与 L3 归档到期都会先落快照，避免不可逆误删。"
          />
        </div>
        <div v-else class="divide-y divide-border/50">
          <div v-for="item in snapshotItems" :key="item.id" class="flex flex-wrap items-center gap-3 px-4 py-3">
            <Badge tone="danger">{{ item.object_type }}</Badge>
            <p class="min-w-0 flex-1 truncate text-sm">{{ item.title }}</p>
            <span class="whitespace-nowrap text-[11px] text-muted-foreground">
              {{ formatDate(item.created_at, true) }} 清除 · 剩余 {{ daysLeft(item.purge_at) }}
            </span>
            <Button
              variant="outline"
              size="sm"
              :disabled="restoreMutation.isPending.value"
              @click="restoreMutation.mutate(item)"
            >
              <Loader2 v-if="restoreMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
              <RotateCcw v-else class="h-3.5 w-3.5" />
              恢复
            </Button>
          </div>
        </div>
      </Card>
    </template>
  </div>
</template>
