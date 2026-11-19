<script setup lang="ts">
import { computed } from 'vue';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'secondary' | 'outline' | 'success' | 'warn' | 'danger' | 'info';

const props = withDefaults(defineProps<{ tone?: Tone; class?: string }>(), { tone: 'secondary' });

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      tone: {
        default: 'border-transparent bg-primary/15 text-primary',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        success: 'border-transparent bg-emerald-500/15 text-emerald-400',
        warn: 'border-transparent bg-amber-500/15 text-amber-400',
        danger: 'border-transparent bg-rose-500/15 text-rose-400',
        info: 'border-transparent bg-sky-500/15 text-sky-400',
      },
    },
    defaultVariants: { tone: 'secondary' },
  },
);

const classes = computed(() => cn(badgeVariants({ tone: props.tone }), props.class));
</script>

<template>
  <span :class="classes"><slot /></span>
</template>
