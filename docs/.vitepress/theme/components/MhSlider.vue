<script setup lang="ts">
import { computed } from 'vue'
import type { Choice } from './duration'

/**
 * Three modes, because the playgrounds need all three:
 *  - `choices`   the model is an index into a list of durations
 *  - `values`    the model is an index into a list of numbers
 *  - `min`/`max` the model is the number itself
 */
const props = defineProps<{
  label: string
  choices?: Choice[]
  values?: number[]
  min?: number
  max?: number
  step?: number
  /** Overrides what is printed next to the label. */
  display?: string
  hint?: string
  disabled?: boolean
}>()

const model = defineModel<number>({ required: true })

const bounds = computed(() => {
  if (props.choices) return { min: 0, max: props.choices.length - 1, step: 1 }
  if (props.values) return { min: 0, max: props.values.length - 1, step: 1 }
  return { min: props.min ?? 0, max: props.max ?? 100, step: props.step ?? 1 }
})

const shown = computed(() => {
  if (props.display !== undefined) return props.display
  if (props.choices) return props.choices[model.value]?.label ?? ''
  if (props.values) return String(props.values[model.value] ?? '')
  return String(model.value)
})
</script>

<template>
  <label class="mh-slider" :class="{ 'is-disabled': disabled }">
    <span class="mh-slider__top">
      <span class="mh-slider__label">{{ label }}</span>
      <span class="mh-slider__value">{{ shown }}</span>
    </span>
    <input
      v-model.number="model"
      type="range"
      :min="bounds.min"
      :max="bounds.max"
      :step="bounds.step"
      :disabled="disabled"
      :aria-label="label"
    />
    <span v-if="hint" class="mh-slider__hint">{{ hint }}</span>
  </label>
</template>
