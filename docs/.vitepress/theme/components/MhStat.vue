<script setup lang="ts">
defineProps<{
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'plain'
}>()
</script>

<template>
  <div class="mh-stat" :class="`is-${tone ?? 'plain'}`">
    <span class="mh-stat__value">{{ value }}</span>
    <span class="mh-stat__label">{{ label }}</span>
    <span v-if="hint" class="mh-stat__hint">{{ hint }}</span>
  </div>
</template>
