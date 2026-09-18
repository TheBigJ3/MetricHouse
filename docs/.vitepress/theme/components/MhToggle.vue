<script setup lang="ts">
defineProps<{
  label: string
  options: readonly { value: string; label: string }[]
  hint?: string
}>()

const model = defineModel<string>({ required: true })
</script>

<template>
  <div class="mh-toggle">
    <span class="mh-toggle__label">{{ label }}</span>
    <div class="mh-toggle__row" role="group" :aria-label="label">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="mh-toggle__button"
        :class="{ 'is-on': model === option.value }"
        :aria-pressed="model === option.value"
        @click="model = option.value"
      >
        {{ option.label }}
      </button>
    </div>
    <span v-if="hint" class="mh-toggle__hint">{{ hint }}</span>
  </div>
</template>
