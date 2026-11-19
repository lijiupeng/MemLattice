<script setup lang="ts">
import { computed } from 'vue';
import { Moon, Network, RefreshCw, Sun } from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';

type ServiceState = 'checking' | 'online' | 'offline';

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    error?: string;
    verifying?: boolean;
    dark?: boolean;
    serviceState?: ServiceState;
  }>(),
  { modelValue: '', error: '', verifying: false, dark: false, serviceState: 'checking' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'submit', value: string): void;
  (e: 'toggle-theme'): void;
}>();

const statusText = computed(() =>
  props.serviceState === 'online' ? '服务在线' : props.serviceState === 'offline' ? '服务不可达' : '连接中',
);

const statusClass = computed(() =>
  props.serviceState === 'online' ? 'bg-emerald-400' : props.serviceState === 'offline' ? 'bg-rose-400' : 'bg-amber-400',
);

function submit(): void {
  if (props.verifying) return;
  emit('submit', props.modelValue);
}
</script>

<template>
  <div class="relative flex min-h-screen items-center justify-center bg-background px-4 py-10">
    <Button
      variant="ghost"
      size="icon"
      class="absolute right-3 top-3 text-muted-foreground"
      :title="dark ? '切到浅色' : '切到深色'"
      @click="emit('toggle-theme')"
    >
      <Moon v-if="dark" class="h-4 w-4" />
      <Sun v-else class="h-4 w-4" />
    </Button>

    <div class="w-full max-w-[420px]">
      <div class="mb-6 flex items-center gap-2.5">
        <div class="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-primary">
          <Network class="h-5 w-5" />
        </div>
        <div class="leading-tight">
          <p class="text-sm font-semibold tracking-tight">MemLattice</p>
          <p class="text-[11px] text-muted-foreground">分层联想记忆</p>
        </div>
      </div>

      <div class="rounded-xl border border-border/70 bg-card p-6 shadow-sm sm:p-7">
        <h1 class="text-lg font-semibold tracking-tight">输入访问令牌</h1>
        <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          所有 API 与 MCP 调用都需要鉴权。验证通过前不会加载任何数据。
        </p>

        <form class="mt-5 space-y-3" novalidate @submit.prevent="submit">
          <div class="space-y-1.5">
            <label for="memlattice-token" class="text-xs font-medium text-muted-foreground">Bearer Token</label>
            <Input
              id="memlattice-token"
              :model-value="modelValue"
              type="password"
              autofocus
              autocomplete="off"
              spellcheck="false"
              placeholder="与服务端 MEMLATTICE_TOKEN 一致"
              :disabled="verifying"
              :aria-invalid="Boolean(error)"
              @update:model-value="emit('update:modelValue', $event)"
            />
          </div>

          <p
            v-if="error"
            role="alert"
            aria-live="polite"
            class="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-600 dark:text-rose-300"
          >
            {{ error }}
          </p>

          <Button type="submit" size="lg" class="w-full" :disabled="verifying || !modelValue.trim()">
            <RefreshCw v-if="verifying" class="h-4 w-4 animate-spin" />
            {{ verifying ? '验证中…' : '连接并进入' }}
          </Button>
        </form>

        <div
          class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-4 text-[11px] text-muted-foreground"
        >
          <span class="inline-flex items-center gap-1.5">
            <span class="h-1.5 w-1.5 rounded-full" :class="statusClass" />
            {{ statusText }}
          </span>
          <span class="ml-auto">令牌只保存在本机浏览器</span>
        </div>
      </div>

      <p class="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground/80">
        令牌来源：<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">MEMLATTICE_TOKEN</code>
        （<code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">.env</code> 或
        <code class="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">docker compose</code> 环境变量）
      </p>
    </div>
  </div>
</template>
