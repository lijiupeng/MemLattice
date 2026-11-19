<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{
  icon?: Component;
  title: string;
  description?: string;
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
    <div v-if="icon" class="rounded-full border border-border/70 bg-muted/40 p-3 text-muted-foreground">
      <component :is="icon" class="h-5 w-5" />
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium">{{ title }}</p>
      <p v-if="description" class="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.default" class="pt-1">
      <slot />
    </div>
  </div>
</template>
