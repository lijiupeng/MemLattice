<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { Loader2, SlidersHorizontal } from 'lucide-vue-next';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Card from '@/components/ui/Card.vue';
import Input from '@/components/ui/Input.vue';
import { api, type SettingEntry, type SettingValue, type SettingsResponse } from '@/lib/api';
import { relativeTime } from '@/lib/format';

const queryClient = useQueryClient();
const draft = reactive<Record<string, SettingValue>>({});
const touched = reactive(new Set<string>());

const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: api.settings });
const payload = computed<SettingsResponse | null>(() => settingsQuery.data.value ?? null);

function clone(value: SettingValue): SettingValue {
  return Array.isArray(value) ? [...value] : value;
}

function sameValue(a: SettingValue | undefined, b: SettingValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

// 服务端数据到达时只补未编辑的项，避免轮询把用户手里的改动冲掉
watch(
  payload,
  (next) => {
    if (!next) return;
    for (const entry of next.entries) {
      if (touched.has(entry.key)) continue;
      draft[entry.key] = clone(entry.value);
    }
  },
  { immediate: true },
);

const groups = computed(() => payload.value?.groups ?? []);
const entries = computed(() => payload.value?.entries ?? []);

const overridden = computed(() => entries.value.filter((entry) => entry.source === 'db').length);
const total = computed(() => entries.value.length);

function entriesOf(group: string): SettingEntry[] {
  return entries.value.filter((entry) => entry.group === group);
}

const dirtyKeys = computed<string[]>(() =>
  entries.value.filter((entry) => !sameValue(draft[entry.key], entry.value)).map((entry) => entry.key),
);

const invalidKeys = computed<string[]>(() =>
  dirtyKeys.value.filter((key) => {
    const value = draft[key];
    return typeof value === 'number' && !Number.isFinite(value);
  }),
);

const dirtySummary = computed(() => {
  const labels = entries.value
    .filter((entry) => dirtyKeys.value.includes(entry.key))
    .map((entry) => entry.label);
  const head = labels.slice(0, 2).join('、');
  return labels.length > 2 ? `${head} 等` : head;
});

function sourceText(entry: SettingEntry): string {
  if (entry.source === 'db') return '页面设置';
  if (entry.source === 'env') return '环境变量';
  return '默认值';
}

function sourceTone(entry: SettingEntry): 'default' | 'info' | 'outline' {
  if (entry.source === 'db') return 'default';
  if (entry.source === 'env') return 'info';
  return 'outline';
}

function display(value: SettingValue, entry: SettingEntry): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(' / ') : '全部直写';
  if (typeof value === 'boolean') return value ? '开' : '关';
  return entry.unit ? `${value} ${entry.unit}` : String(value);
}

function numericValue(key: string): string {
  const value = draft[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function setNumber(key: string, raw: string): void {
  touched.add(key);
  const text = raw.trim();
  draft[key] = text === '' ? Number.NaN : Number(text);
}

function isOn(key: string): boolean {
  return draft[key] === true;
}

function toggle(key: string): void {
  touched.add(key);
  draft[key] = !isOn(key);
}

function isPicked(key: string, option: string): boolean {
  const value = draft[key];
  return Array.isArray(value) && value.includes(option);
}

function toggleLabel(key: string, option: string): void {
  const value = draft[key];
  const current = Array.isArray(value) ? value : [];
  touched.add(key);
  draft[key] = current.includes(option)
    ? current.filter((item) => item !== option)
    : [...current, option];
}

function publish(): void {
  touched.clear();
  void queryClient.invalidateQueries({ queryKey: ['settings'] });
  void queryClient.invalidateQueries({ queryKey: ['metrics'] });
}

const saveMutation = useMutation({
  mutationFn: (values: Record<string, SettingValue>) => api.putSettings(values),
  onSuccess: (result) => {
    toast.success(`已保存 ${result.changed.length} 项`, {
      description: result.restart_pending ? '巡检开关与时刻需重启服务后按新排程执行' : '新值已立即生效',
    });
    publish();
  },
  onError: (err: Error) => toast.error('保存失败', { description: err.message }),
});

const resetMutation = useMutation({
  mutationFn: (key: string) => api.resetSetting(key),
  onSuccess: (result) => {
    touched.delete(result.key);
    draft[result.key] = clone(result.value);
    toast.success('已恢复默认');
    publish();
  },
  onError: (err: Error) => toast.error('重置失败', { description: err.message }),
});

function save(): void {
  if (invalidKeys.value.length > 0) {
    toast.warning('有参数不是有效数字', { description: '请补齐后再保存' });
    return;
  }
  const values: Record<string, SettingValue> = {};
  for (const key of dirtyKeys.value) values[key] = draft[key];
  saveMutation.mutate(values);
}

function discard(): void {
  for (const entry of entries.value) draft[entry.key] = clone(entry.value);
  touched.clear();
}

function resetOne(key: string): void {
  resetMutation.mutate(key);
}
</script>

<template>
  <div class="space-y-4">
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground"
    >
      <span class="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
        <SlidersHorizontal class="h-4 w-4" />
        运行时可调参数
      </span>
      <span>共 {{ total }} 项</span>
      <span>页面覆盖 {{ overridden }} 项</span>
      <span v-if="payload?.updated_at">最近修改 {{ relativeTime(payload.updated_at) }}</span>
      <span class="ml-auto">保存即生效；标「重启生效」的项除外</span>
    </div>

    <div v-if="settingsQuery.isPending.value" class="grid gap-4 xl:grid-cols-[200px_minmax(0,1fr)]">
      <div class="hidden space-y-2 xl:block">
        <div v-for="i in 5" :key="i" class="h-7 animate-pulse rounded-md bg-muted/60" />
      </div>
      <div class="space-y-4">
        <div v-for="i in 3" :key="i" class="h-48 animate-pulse rounded-lg border bg-card" />
      </div>
    </div>

    <div
      v-else-if="settingsQuery.isError.value"
      class="rounded-lg border border-rose-500/40 bg-rose-500/5 p-4 text-sm"
    >
      <p class="font-medium text-rose-400">读取设置失败</p>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ (settingsQuery.error.value as Error)?.message }}
      </p>
      <Button variant="outline" size="sm" class="mt-3" @click="settingsQuery.refetch()">重试</Button>
    </div>

    <div v-else class="grid gap-4 xl:grid-cols-[200px_minmax(0,1fr)]">
      <aside class="hidden xl:block">
        <nav class="sticky top-24 space-y-1">
          <a
            v-for="group in groups"
            :key="group.key"
            :href="`#setting-${group.key}`"
            class="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <span>{{ group.title }}</span>
            <span class="text-[11px] tabular-nums text-muted-foreground/60">
              {{ entriesOf(group.key).length }}
            </span>
          </a>
        </nav>
      </aside>

      <div class="space-y-4">
        <Card
          v-for="group in groups"
          :id="`setting-${group.key}`"
          :key="group.key"
          :title="group.title"
          :description="group.description"
        >
          <div class="divide-y divide-border/60">
            <div
              v-for="entry in entriesOf(group.key)"
              :key="entry.key"
              class="grid gap-3 py-3.5 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
            >
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="text-sm font-medium">{{ entry.label }}</span>
                  <Badge :tone="sourceTone(entry)" class="!py-0">{{ sourceText(entry) }}</Badge>
                  <Badge v-if="entry.restart" tone="warn" class="!py-0">重启生效</Badge>
                </div>
                <p class="text-xs leading-relaxed text-muted-foreground">{{ entry.hint }}</p>
                <p class="font-mono text-[11px] text-muted-foreground/60">
                  {{ entry.key }} · 默认 {{ display(entry.default, entry) }}
                </p>
              </div>

              <div class="flex items-center justify-end gap-2">
                <template v-if="entry.type === 'number'">
                  <Input
                    :model-value="numericValue(entry.key)"
                    type="number"
                    class="w-28 text-right tabular-nums"
                    :min="entry.min"
                    :max="entry.max"
                    :step="entry.step ?? (entry.integer ? 1 : 0.01)"
                    @update:model-value="(value) => setNumber(entry.key, value)"
                  />
                  <span class="w-12 shrink-0 text-xs text-muted-foreground">{{ entry.unit ?? '' }}</span>
                </template>

                <button
                  v-else-if="entry.type === 'boolean'"
                  type="button"
                  role="switch"
                  :aria-checked="isOn(entry.key)"
                  class="relative h-6 w-11 shrink-0 rounded-full border transition-colors"
                  :class="isOn(entry.key) ? 'border-primary bg-primary' : 'border-border bg-muted'"
                  @click="toggle(entry.key)"
                >
                  <span
                    class="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-background shadow transition-all"
                    :class="isOn(entry.key) ? 'left-[22px]' : 'left-0.5'"
                  />
                </button>

                <div v-else class="flex flex-wrap items-center justify-end gap-1.5">
                  <button
                    v-for="option in entry.options ?? []"
                    :key="option"
                    type="button"
                    class="rounded-full border px-2.5 py-1 text-xs transition-colors"
                    :class="
                      isPicked(entry.key, option)
                        ? 'border-primary bg-primary/15 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent/60'
                    "
                    @click="toggleLabel(entry.key, option)"
                  >
                    {{ option }}
                  </button>
                </div>

                <Button
                  v-if="entry.source === 'db'"
                  variant="ghost"
                  size="sm"
                  class="shrink-0"
                  :disabled="resetMutation.isPending.value"
                  @click="resetOne(entry.key)"
                >
                  重置
                </Button>
              </div>
            </div>
          </div>
        </Card>

        <Card title="服务与连接" description="来自部署环境；改这些需要改配置并重启进程">
          <dl class="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div v-for="item in payload?.service ?? []" :key="item.label" class="min-w-0 space-y-0.5">
              <dt class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {{ item.label }}
              </dt>
              <dd class="truncate font-mono text-xs" :title="item.value">{{ item.value }}</dd>
              <p class="text-[11px] text-muted-foreground/60">{{ item.hint }}</p>
            </div>
          </dl>
        </Card>
      </div>
    </div>

    <div v-if="dirtyKeys.length > 0" class="sticky bottom-4 z-20">
      <div
        class="flex flex-wrap items-center gap-3 rounded-lg border bg-card/95 px-4 py-3 shadow-lg backdrop-blur"
      >
        <span class="text-sm">
          已修改
          <span class="font-semibold tabular-nums">{{ dirtyKeys.length }}</span>
          项
        </span>
        <span class="hidden truncate text-xs text-muted-foreground sm:inline">{{ dirtySummary }}</span>
        <div class="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" :disabled="saveMutation.isPending.value" @click="discard">
            放弃
          </Button>
          <Button size="sm" :disabled="saveMutation.isPending.value" @click="save">
            <Loader2 v-if="saveMutation.isPending.value" class="h-3.5 w-3.5 animate-spin" />
            保存并应用
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
