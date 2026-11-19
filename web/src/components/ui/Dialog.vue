<script setup lang="ts">
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  class?: string;
}>();

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
</script>

<template>
  <DialogRoot :open="props.open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <DialogContent
        :class="
          cn(
            'fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l bg-card shadow-2xl',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-4 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right-4',
            props.class,
          )
        "
      >
        <header class="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div class="min-w-0 space-y-1">
            <DialogTitle class="truncate text-base font-semibold tracking-tight">{{ title }}</DialogTitle>
            <DialogDescription v-if="description" class="text-xs text-muted-foreground">
              {{ description }}
            </DialogDescription>
          </div>
          <button
            type="button"
            class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="关闭"
            @click="emit('update:open', false)"
          >
            <X class="h-4 w-4" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="border-t border-border/60 px-5 py-3">
          <slot name="footer" />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
