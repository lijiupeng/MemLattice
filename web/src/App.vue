<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { Toaster, toast } from 'vue-sonner';
import 'vue-sonner/style.css';
import {
  Blocks,
  Eye,
  Inbox,
  Layers,
  Moon,
  Network,
  RefreshCw,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-vue-next';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import TokenGate from '@/components/TokenGate.vue';
import { api, ApiError, getToken, setToken } from '@/lib/api';

const route = useRoute();
const queryClient = useQueryClient();

const nav = [
  { to: '/cards', label: '记忆卡片', icon: Layers, key: 'cards' },
  { to: '/graph', label: '联想图谱', icon: Network, key: 'graph' },
  { to: '/recall', label: '记忆检索', icon: Sparkles, key: 'recall' },
  { to: '/session', label: '会话预览', icon: Eye, key: 'session' },
  { to: '/blocks', label: '常驻层', icon: Blocks, key: 'blocks' },
  { to: '/candidates', label: '待审队列', icon: Inbox, key: 'candidates' },
  { to: '/trash', label: '回收站', icon: Trash2, key: 'trash' },
  { to: '/audit', label: '审计日志', icon: ScrollText, key: 'audit' },
  { to: '/settings', label: '设置', icon: SlidersHorizontal, key: 'settings' },
];

// 令牌校验通过前不渲染业务页面，也不发受保护请求
const authed = ref(Boolean(getToken()));
const gateDraft = ref(getToken());
const gateError = ref('');
const verifying = ref(false);
const tokenOpen = ref(false);
const tokenDraft = ref(getToken());
const dark = ref(document.documentElement.classList.contains('dark'));

const health = useQuery({
  queryKey: ['health'],
  queryFn: api.health,
  retry: false,
  refetchInterval: 30_000,
});

const metrics = useQuery({
  queryKey: ['metrics'],
  queryFn: api.metrics,
  retry: false,
  refetchInterval: 60_000,
  enabled: computed(() => authed.value),
});

const authError = computed(() => {
  const err = metrics.error.value as { status?: number } | null;
  return err?.status === 401;
});

// 令牌失效（轮换/清空）时退回令牌页，而不是让页面一直空着
watch(authError, (unauthorized) => {
  if (!unauthorized) return;
  authed.value = false;
  gateDraft.value = getToken();
  gateError.value = '令牌已失效或未授权，请重新输入';
});

const serviceState = computed<'checking' | 'online' | 'offline'>(() =>
  health.isSuccess.value ? 'online' : health.isError.value ? 'offline' : 'checking',
);

const pending = computed(() => metrics.data.value?.counts?.candidates ?? 0);
const cardCount = computed(() => metrics.data.value?.counts?.cards ?? 0);

function badgeFor(key: string): number | null {
  if (key === 'candidates' && pending.value > 0) return pending.value;
  return null;
}

function toggleTheme(): void {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
  try {
    localStorage.setItem('memlattice.theme', dark.value ? 'dark' : 'light');
  } catch {
    /* ignore */
  }
}

function openToken(): void {
  tokenDraft.value = getToken();
  tokenOpen.value = true;
}

function saveTokenDraft(): void {
  const token = tokenDraft.value.trim();
  setToken(token);
  tokenOpen.value = false;
  tokenDraft.value = '';
  authed.value = Boolean(token);
  gateDraft.value = token;
  gateError.value = '';
  void queryClient.invalidateQueries();
  toast.success(token ? '访问令牌已保存' : '访问令牌已清除');
}

// 先拿受保护接口验一次令牌，成功才进入主界面，避免进去了却全是空列表
async function submitGate(value: string): Promise<void> {
  const token = value.trim();
  if (verifying.value) return;
  if (!token) {
    gateError.value = '请输入访问令牌';
    return;
  }
  verifying.value = true;
  gateError.value = '';
  const previous = getToken();
  setToken(token);
  try {
    await api.metrics();
    authed.value = true;
    gateDraft.value = token;
    void queryClient.invalidateQueries();
    toast.success('已连接');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // 无效令牌不落盘，避免刷新后先闪一下空主界面
      setToken('');
      gateError.value = '令牌不正确：请与服务端的 MEMLATTICE_TOKEN 保持一致';
    } else {
      setToken(previous);
      gateError.value = err instanceof ApiError
        ? `请求被拒绝：${err.message}`
        : '无法连接服务，请确认服务已启动后重试';
    }
  } finally {
    verifying.value = false;
  }
}

function runPatrol(): void {
  void api
    .patrol()
    .then((report) => {
      toast.success('巡检完成', {
        description: `淘汰 ${report.evicted} · 降级 ${report.demotion} · 骨架化 ${report.skeletonized} · ${report.duration_ms}ms`,
      });
      void queryClient.invalidateQueries();
    })
    .catch((err: Error) => toast.error('巡检失败', { description: err.message }));
}

function initTheme(): void {
  try {
    const saved = localStorage.getItem('memlattice.theme');
    if (saved === 'light' || saved === 'dark') {
      dark.value = saved === 'dark';
      document.documentElement.classList.toggle('dark', dark.value);
    }
  } catch {
    /* ignore */
  }
}
initTheme();
</script>

<template>
  <div class="min-h-screen bg-background">
    <TokenGate
      v-if="!authed"
      v-model="gateDraft"
      :error="gateError"
      :verifying="verifying"
      :dark="dark"
      :service-state="serviceState"
      @submit="submitGate"
      @toggle-theme="toggleTheme"
    />

    <div v-else class="mx-auto flex min-h-screen w-full max-w-[1600px]">
      <!-- 侧边导航 -->
      <aside class="hidden w-60 shrink-0 flex-col border-r border-border/70 bg-sidebar/60 lg:flex">
        <div class="flex items-center gap-2.5 px-5 py-5">
          <div class="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-primary">
            <Network class="h-5 w-5" />
          </div>
          <div class="leading-tight">
            <p class="text-sm font-semibold tracking-tight">MemLattice</p>
            <p class="text-[11px] text-muted-foreground">分层联想记忆</p>
          </div>
        </div>

        <nav class="flex-1 space-y-1 px-3">
          <RouterLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            active-class="!bg-accent text-foreground font-medium"
          >
            <component :is="item.icon" class="h-4 w-4 shrink-0" />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <span
              v-if="badgeFor(item.key)"
              class="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
            >
              {{ badgeFor(item.key) }}
            </span>
            <span
              v-else-if="item.key === 'cards' && cardCount > 0"
              class="text-[10px] tabular-nums text-muted-foreground/70"
            >
              {{ cardCount }}
            </span>
          </RouterLink>
        </nav>

        <div class="space-y-3 border-t border-border/70 px-4 py-4">
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span
              class="h-1.5 w-1.5 rounded-full"
              :class="health.isSuccess.value ? 'bg-emerald-400' : health.isError.value ? 'bg-rose-400' : 'bg-amber-400'"
            />
            <span class="truncate">
              {{ health.isSuccess.value ? '服务在线' : health.isError.value ? '服务不可达' : '连接中' }}
            </span>
            <span class="ml-auto truncate">无内置模型</span>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" class="flex-1" @click="openToken">
              <Settings2 class="h-3.5 w-3.5" />
              令牌
            </Button>
            <Button variant="ghost" size="icon" :title="dark ? '切到浅色' : '切到深色'" @click="toggleTheme">
              <Moon v-if="dark" class="h-4 w-4" />
              <Sun v-else class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <!-- 主区域 -->
      <div class="flex min-w-0 flex-1 flex-col">
        <header class="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
          <div class="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
            <div class="min-w-0 flex-1">
              <h1 class="truncate text-[15px] font-semibold tracking-tight">{{ route.meta.title }}</h1>
              <p class="truncate text-xs text-muted-foreground">{{ route.meta.description }}</p>
            </div>
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" @click="runPatrol">
                <RefreshCw class="h-3.5 w-3.5" />
                运行巡检
              </Button>
              <RouterLink to="/recall">
                <Button size="sm">
                  <Sparkles class="h-3.5 w-3.5" />
                  记忆检索
                </Button>
              </RouterLink>
            </div>
          </div>

          <!-- 移动端导航 -->
          <nav class="no-scrollbar flex gap-1 overflow-x-auto border-t border-border/60 px-3 py-2 lg:hidden">
            <RouterLink
              v-for="item in nav"
              :key="item.to"
              :to="item.to"
              class="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground"
              active-class="!bg-accent text-foreground"
            >
              <component :is="item.icon" class="h-3.5 w-3.5" />
              {{ item.label }}
            </RouterLink>
          </nav>
        </header>

        <main class="min-h-0 flex-1 px-4 py-5 sm:px-6">
          <RouterView />
        </main>
      </div>
    </div>

    <Dialog v-model:open="tokenOpen" title="访问令牌" description="所有 API 与 MCP 调用均需鉴权（FR-11）">
      <div class="space-y-4">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">Bearer Token</label>
          <Input v-model="tokenDraft" type="password" placeholder="与服务端 MEMLATTICE_TOKEN 一致" />
        </div>
        <p class="text-xs leading-relaxed text-muted-foreground">
          令牌保存在浏览器 localStorage，仅用于本机管理端。生产环境请通过 TLS 反代并限制来源白名单。
        </p>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="tokenOpen = false">取消</Button>
          <Button @click="saveTokenDraft">保存并刷新</Button>
        </div>
      </template>
    </Dialog>

    <Toaster position="top-right" :theme="dark ? 'dark' : 'light'" :rich-colors="true" />
  </div>
</template>
