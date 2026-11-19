<script setup lang="ts">
import { cn } from '@/lib/utils';

const props = defineProps<{
  title?: string;
  description?: string;
  class?: string;
  bodyClass?: string;
  flush?: boolean;
}>();
</script>

<template>
  <section :class="cn('rounded-lg border bg-card text-card-foreground shadow-sm', props.class)">
    <header
      v-if="title || description || $slots.actions || $slots.header"
      class="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3"
    >
      <div class="min-w-0 space-y-0.5">
        <slot name="header">
          <h2 v-if="title" class="truncate text-sm font-semibold tracking-tight">{{ title }}</h2>
          <p v-if="description" class="text-xs text-muted-foreground">{{ description }}</p>
        </slot>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div :class="cn(flush ? '' : 'p-4', props.bodyClass)">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="border-t border-border/60 px-4 py-3">
      <slot name="footer" />
    </footer>
  </section>
</template>
