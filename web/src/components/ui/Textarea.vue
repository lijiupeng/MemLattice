<script setup lang="ts">
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
    rows?: number;
    class?: string;
    disabled?: boolean;
  }>(),
  { rows: 4, disabled: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :rows="props.rows"
    :disabled="props.disabled"
    :class="
      cn(
        'flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed shadow-sm transition-colors',
        'placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
    @input="onInput"
  />
</template>
