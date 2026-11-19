<script setup lang="ts">
import { computed } from 'vue';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
type Size = 'default' | 'sm' | 'lg' | 'icon';

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    class?: string;
  }>(),
  { variant: 'default', size: 'default', type: 'button', disabled: false },
);

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-border bg-transparent hover:bg-accent/60 hover:text-accent-foreground',
        ghost: 'hover:bg-accent/60 hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3.5',
        sm: 'h-8 px-2.5 text-xs',
        lg: 'h-10 px-5',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

const classes = computed(() => cn(buttonVariants({ variant: props.variant, size: props.size }), props.class));
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled">
    <slot />
  </button>
</template>
