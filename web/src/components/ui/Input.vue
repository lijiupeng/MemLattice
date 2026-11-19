<script setup lang="ts">
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    modelValue?: string | number;
    placeholder?: string;
    type?: string;
    class?: string;
    disabled?: boolean;
    min?: number;
    max?: number;
    step?: number;
    maxlength?: number;
  }>(),
  { type: 'text', disabled: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <input
    :type="props.type"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :min="props.min"
    :max="props.max"
    :step="props.step"
    :maxlength="props.maxlength"
    :class="
      cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
        'placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
    @input="onInput"
  />
</template>
