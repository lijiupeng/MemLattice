<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Blocks, Eye, Link2, Loader2, Pencil, Sparkles, Trash2 } from 'lucide-vue-next';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import Textarea from '@/components/ui/Textarea.vue';
import BlockEditor from '@/components/BlockEditor.vue';
import { api, type BlockItem } from '@/lib/api';
import { LABEL_TEXT } from '@/lib/format';

const queryClient = useQueryClient();
const revokeTarget = ref<BlockItem | null>(null);
const detailTarget = ref<BlockItem | null>(null);

const blocksQuery = useQuery({ queryKey: ['blocks'], queryFn: api.blocks });

const blocks = computed<BlockItem[]>(() => blocksQuery.data.value ?? []);
const byLabel = (label: string): BlockItem | undefined =>
  blocks.value.find((block) => block.label === label && block.slot === 'default');
// 通用经验（slot=default）与按词经验（slot=skill:<term_id>）都展示；
// 预算只统计按词条目（淘汰也只作用于 skill:*）。
const generalSkill = computed(() =>
  blocks.value.find(
    (block) => block.label === 'skills' && block.slot === 'default' && block.content.trim().length > 0,
  ),
);
const skillEntries = computed(() =>
  blocks.value
    .filter((block) => block.label === 'skills' && block.slot !== 'default' && block.content.trim().length > 0)
    .sort((a, b) => b.heat - a.heat || b.use_count - a.use_count || a.id - b.id),
);
const skills = computed(() => [
  ...(generalSkill.value ? [generalSkill.value] : []),
  ...skillEntries.value,
]);
const skillsTokens = computed(() => skillEntries.value.reduce((sum, item) => sum + item.tokens, 0));

/** L1 常驻块只呈现一句话总结，详细描述不进这里（只在编辑弹窗里看/改） */
function skillSummary(entry: BlockItem): string {
  return (entry.summary ?? '').trim();
}

const NO_SUMMARY = '（未填写一句话总结）';

/* ---------------------------------------------------------------- 编辑 */

const editTarget = ref<BlockItem | null>(null);
const editSummary = ref('');
const editContent = ref('');

// 所有 skills 块（含 default 通用经验）都用"一句话总结 + 详细描述"
const isTermSkill = computed(() => editTarget.value !== null && editTarget.value.label === 'skills');
const summaryLimit = computed(() => (isTermSkill.value ? 60 : 0));
const contentLimit = computed(() => editTarget.value?.char_limit ?? 4000);
const summaryTooLong = computed(() => isTermSkill.value && editSummary.value.length > summaryLimit.value);
const contentTooLong = computed(() => editContent.value.length > contentLimit.value);
const canSave = computed(
  () =>
    editTarget.value !== null &&
    editContent.value.trim().length > 0 &&
    !contentTooLong.value &&
    !summaryTooLong.value,
);

function openEdit(entry: BlockItem): void {
  editTarget.value = entry;
  editSummary.value = (entry.summary ?? '').trim();
  editContent.value = entry.content;
}

/** 详情弹窗里直接跳去编辑 */
function editFromDetail(): void {
  const entry = detailTarget.value;
  if (!entry) return;
  detailTarget.value = null;
  openEdit(entry);
}

const saveMutation = useMutation({
  mutationFn: () =>
    api.putBlock(
      'skills',
      editContent.value,
      editTarget.value?.slot ?? 'default',
      isTermSkill.value ? editSummary.value : undefined,
    ),
  onSuccess: () => {
    editTarget.value = null;
    toast.success('已保存经验条目', { description: '一句话描述进索引，详细描述按 id 取用' });
    void queryClient.invalidateQueries({ queryKey: ['blocks'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('保存失败', { description: err.message }),
});

const revokeMutation = useMutation({
  mutationFn: (block: BlockItem) => api.deleteBlock(block.id),
  onSuccess: () => {
    revokeTarget.value = null;
    toast.success('已撤销该经验条目', { description: '来源事件卡与原文均保留' });
    void queryClient.invalidateQueries({ queryKey: ['blocks'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
  },
  onError: (err: Error) => toast.error('撤销失败', { description: err.message }),
});

const editable = computed(() => {
  const rows: Array<{ label: 'persona' | 'rules'; block: BlockItem }> = [];
  for (const label of ['persona', 'rules'] as const) {
    const block = byLabel(label);
    if (block) rows.push({ label, block });
  }
  return rows;
});

// 常驻块共用一张卡，用选项卡切换；默认打开第一项，目标块缺失时回退到第一个
type EditableLabel = 'persona' | 'rules';
const activeTab = ref<EditableLabel>('persona');
const activeRow = computed(
  () => editable.value.find((row) => row.label === activeTab.value) ?? editable.value[0],
);
</script>

<template>
  <div class="space-y-4">
    <div v-if="blocksQuery.isPending.value" class="grid gap-4 lg:grid-cols-2">
      <Skeleton v-for="i in 4" :key="i" class="h-48 w-full" />
    </div>

    <div v-else-if="blocksQuery.isError.value" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
      加载失败：{{ (blocksQuery.error.value as Error)?.message }}
    </div>

    <template v-else>
      <Card>
        <template #header>
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <Button
                v-for="item in editable"
                :key="item.label"
                size="sm"
                :variant="activeRow?.label === item.label ? 'default' : 'ghost'"
                @click="activeTab = item.label"
              >
                {{ LABEL_TEXT[item.label]?.title ?? item.label }}
              </Button>
            </div>
            <p v-if="activeRow" class="text-xs text-muted-foreground">
              {{ LABEL_TEXT[activeRow.label]?.hint }}
            </p>
          </div>
        </template>
        <BlockEditor
          v-if="activeRow"
          :key="activeRow.label"
          :block="activeRow.block"
          :title="LABEL_TEXT[activeRow.label]?.title ?? activeRow.label"
          :hint="`${activeRow.block.tokens} tokens · ${activeRow.block.source === 'agent' ? '调用方写入' : '人工维护'}`"
        />
      </Card>

      <!-- 固化经验 -->
      <Card
        title="固化经验（L1 skills）"
        description="每条 = id + 一句话描述 + 详细描述；L1 只注入热度前 5 条索引，详细描述按 id 取用"
        flush
      >
        <template #actions>
          <Badge tone="outline">{{ skills.length }} 条</Badge>
          <Badge tone="secondary">注入前 5</Badge>
          <Badge :tone="skillsTokens > 400 ? 'warn' : 'secondary'">{{ skillsTokens }} / 400 tokens（按词）</Badge>
        </template>

        <div v-if="skills.length === 0" class="px-4 py-10 text-center">
          <Sparkles class="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
          <p class="text-sm text-muted-foreground">还没有经验条目</p>
          <p class="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground/80">
            经验条只由调用方写入：通用经验用 slot=default，按词条目用 slot=skill:&lt;term_id&gt;。服务端不再自动固化。
          </p>
        </div>

        <div v-else class="divide-y divide-border/50">
          <div v-for="entry in skills" :key="entry.id" class="px-4 py-3">
            <div class="flex flex-wrap items-start gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-baseline gap-2">
                  <Badge tone="outline" class="font-mono">#{{ entry.id }}</Badge>
                  <p
                    v-if="skillSummary(entry)"
                    class="min-w-0 text-sm leading-relaxed"
                  >
                    {{ skillSummary(entry) }}
                  </p>
                  <p v-else class="min-w-0 text-sm leading-relaxed text-muted-foreground/70">
                    {{ NO_SUMMARY }}
                  </p>
                </div>

                <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Badge tone="outline">{{ entry.slot === 'default' ? '通用' : entry.slot }}</Badge>
                  <Badge tone="default">heat {{ entry.heat.toFixed(2) }}</Badge>
                  <Badge tone="default">调用 {{ entry.use_count }} 次</Badge>
                  <span class="inline-flex items-center gap-1">
                    <Link2 class="h-3 w-3" />来源词 {{ entry.ref_terms?.length ?? 0 }}
                  </span>
                  <span>·</span>
                  <span>来源卡 {{ entry.ref_cards?.length ?? 0 }}</span>
                </div>
              </div>

              <div class="flex items-center gap-1">
                <Button variant="ghost" size="sm" @click="detailTarget = entry">
                  <Eye class="h-3.5 w-3.5" />详情
                </Button>
                <Button variant="ghost" size="sm" @click="openEdit(entry)">
                  <Pencil class="h-3.5 w-3.5" />编辑
                </Button>
                <Button variant="ghost" size="sm" class="text-rose-400 hover:text-rose-300" @click="revokeTarget = entry">
                  <Trash2 class="h-3.5 w-3.5" />撤销
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <p class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Blocks class="h-3.5 w-3.5" />
        rules 与 persona 可由调用方写入，是否需人工审核取决于服务端审核名单（默认直写）；经验条超预算时按热度淘汰最冷条目。
      </p>
    </template>

    <!-- 经验详情 -->
    <Dialog
      :open="Boolean(detailTarget)"
      title="经验详情"
      :description="detailTarget ? `#${detailTarget.id} · ${detailTarget.slot === 'default' ? '通用' : detailTarget.slot}` : ''"
      class="max-w-2xl"
      @update:open="(open) => { if (!open) detailTarget = null }"
    >
      <div class="space-y-4">
        <div class="space-y-1">
          <p class="text-xs text-muted-foreground">一句话总结（L1 只注入这条）</p>
          <p class="text-sm leading-relaxed">{{ detailTarget ? skillSummary(detailTarget) || NO_SUMMARY : '' }}</p>
        </div>
        <div class="space-y-1">
          <p class="text-xs text-muted-foreground">详细描述（按 block_id 取用，不进 L1）</p>
          <p
            class="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm leading-relaxed"
          >
            {{ detailTarget?.content }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <Badge tone="default">heat {{ detailTarget?.heat.toFixed(2) }}</Badge>
          <Badge tone="default">调用 {{ detailTarget?.use_count }} 次</Badge>
          <Badge tone="outline">来源词 {{ detailTarget?.ref_terms?.length ?? 0 }}</Badge>
          <Badge tone="outline">来源卡 {{ detailTarget?.ref_cards?.length ?? 0 }}</Badge>
        </div>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="detailTarget = null">关闭</Button>
          <Button @click="editFromDetail">
            <Pencil class="h-3.5 w-3.5" />编辑
          </Button>
        </div>
      </template>
    </Dialog>

    <!-- 编辑经验 -->
    <Dialog
      :open="Boolean(editTarget)"
      title="编辑经验条目"
      description="一句话描述进 L1 索引；详细描述按 block_id 现取"
      class="max-w-2xl"
      @update:open="(open) => { if (!open) editTarget = null }"
    >
      <div class="space-y-4">
        <div v-if="isTermSkill" class="space-y-1.5">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>一句话描述（进 L1 索引，≤{{ summaryLimit }} 字）</span>
            <span :class="summaryTooLong ? 'text-rose-400' : ''">{{ editSummary.length }} / {{ summaryLimit }}</span>
          </div>
          <Input
            v-model="editSummary"
            :maxlength="summaryLimit"
            placeholder="例如：提到股票时先给结论，再补一条可执行建议"
          />
        </div>

        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>{{ isTermSkill ? '详细描述（按 block_id 取用）' : '内容' }}</span>
            <span :class="contentTooLong ? 'text-rose-400' : ''">{{ editContent.length }} / {{ contentLimit }}</span>
          </div>
          <Textarea
            v-model="editContent"
            :rows="isTermSkill ? 8 : 6"
            :maxlength="contentLimit"
            placeholder="条件、步骤、注意事项……"
          />
        </div>

        <p v-if="isTermSkill" class="text-[11px] leading-relaxed text-muted-foreground">
          只有一句话描述会随 recall 注入；详细描述在命中时由 agent 用
          <code class="rounded bg-muted px-1 py-0.5">memory.expand {"block_id": {{ editTarget?.id }}}</code>
          取回，取用一次计一次调用。
        </p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="editTarget = null">取消</Button>
          <Button :disabled="saveMutation.isPending.value || !canSave" @click="saveMutation.mutate()">
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
            保存
          </Button>
        </div>
      </template>
    </Dialog>

    <Dialog
      :open="Boolean(revokeTarget)"
      title="撤销固化条目"
      description="仅移出 L1，不删除任何来源数据"
      class="max-w-md"
      @update:open="(open) => { if (!open) revokeTarget = null }"
    >
      <div class="space-y-2">
        <p class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm">
          <span v-if="revokeTarget" class="mr-1 font-mono text-xs text-muted-foreground">#{{ revokeTarget.id }}</span>
          {{ revokeTarget ? skillSummary(revokeTarget) || NO_SUMMARY : '' }}
        </p>
        <p class="text-xs leading-relaxed text-muted-foreground">
          {{ revokeTarget?.slot === 'default'
            ? '通用经验会停止注入；服务重启时会重建一个空容器。需要恢复时由调用方重新写入。'
            : '撤销后该条目移出 L1，来源词、详细描述与原文引用保持完好；需要恢复时由调用方重新写入。' }}
        </p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="revokeTarget = null">取消</Button>
          <Button
            variant="destructive"
            :disabled="revokeMutation.isPending.value"
            @click="revokeTarget && revokeMutation.mutate(revokeTarget)"
          >
            <Loader2 v-if="revokeMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
            确认撤销
          </Button>
        </div>
      </template>
    </Dialog>
  </div>
</template>
