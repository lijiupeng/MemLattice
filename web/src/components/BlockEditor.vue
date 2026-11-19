<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Loader2, Save, ShieldAlert } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Textarea from '@/components/ui/Textarea.vue';
import Badge from '@/components/ui/Badge.vue';
import { api, type BlockItem } from '@/lib/api';

const props = defineProps<{ block: BlockItem; title: string; hint: string }>();
const queryClient = useQueryClient();
const content = ref(props.block.content);
const saved = ref(props.block.content);

watch(
  () => props.block.content,
  (next) => {
    content.value = next;
    saved.value = next;
  },
);

const length = computed(() => [...content.value].length);
const overLimit = computed(() => length.value > props.block.char_limit);
const dirty = computed(() => content.value !== saved.value);

const saveMutation = useMutation({
  mutationFn: () => api.putBlock(props.block.label, content.value, props.block.slot),
  onSuccess: () => {
    saved.value = content.value;
    toast.success(`${props.title}已保存`, { description: '版本已递增，可回滚' });
    void queryClient.invalidateQueries({ queryKey: ['blocks'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('保存失败', { description: err.message }),
});
</script>

<template>
  <div class="space-y-2.5">
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">{{ hint }}</p>
      <div class="flex items-center gap-2 whitespace-nowrap">
        <Badge v-if="block.read_only" tone="warn"><ShieldAlert class="h-3 w-3" />改需审核</Badge>
        <Badge tone="outline">v{{ block.version }}</Badge>
        <span class="text-[11px] tabular-nums" :class="overLimit ? 'text-rose-400' : 'text-muted-foreground'">
          {{ length }} / {{ block.char_limit }}
        </span>
      </div>
    </div>
    <Textarea
      v-model="content"
      :rows="12"
      :placeholder="block.label === 'rules' ? '写入硬规则，例如：回答前先给结论' : '暂无内容'"
    />
    <div class="flex items-center gap-2">
      <Button size="sm" :disabled="!dirty || overLimit || saveMutation.isPending.value" @click="saveMutation.mutate()">
        <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
        <Save v-else class="h-3.5 w-3.5" />
        保存
      </Button>
      <span v-if="dirty" class="text-[11px] text-amber-400">未保存</span>
      <span v-else class="text-[11px] text-muted-foreground">保存会生成新版本</span>
    </div>
  </div>
</template>
