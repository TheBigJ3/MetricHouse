<script setup lang="ts">
import { computed, ref } from 'vue'
import MhSlider from './MhSlider.vue'

const props = withDefaults(
  defineProps<{
    metric?: string
    kind?: 'gauge' | 'timer'
    unit?: string
    /** Starting observations for the open bucket. */
    start?: number[]
    max?: number
  }>(),
  {
    metric: 'online_users',
    kind: 'gauge',
    unit: '',
    start: () => [640, 1301, 980, 1266],
    max: 2000,
  },
)

const ALL = ['last', 'min', 'max', 'sum', 'count'] as const
type Aggregate = (typeof ALL)[number]

const values = ref<number[]>([...props.start])

/** A timer leaves `last` out by default: the last thing to finish is arbitrary. */
const stored = ref<Aggregate[]>(props.kind === 'timer' ? ['min', 'max', 'sum', 'count'] : [...ALL])

function toggleAggregate(name: Aggregate): void {
  if (stored.value.includes(name)) {
    // at least one has to reach the sink, exactly as the library requires
    if (stored.value.length === 1) return
    stored.value = stored.value.filter((one) => one !== name)
    return
  }
  stored.value = ALL.filter((one) => one === name || stored.value.includes(one))
}

function addObservation(): void {
  if (values.value.length >= 8) return
  const last = values.value.at(-1) ?? Math.round(props.max / 2)
  values.value = [...values.value, last]
}

function removeObservation(): void {
  if (values.value.length <= 1) return
  values.value = values.value.slice(0, -1)
}

const fold = computed(() => {
  const list = values.value
  return {
    last: list.at(-1) ?? 0,
    min: Math.min(...list),
    max: Math.max(...list),
    sum: list.reduce((total, one) => total + one, 0),
    count: list.length,
  }
})

const average = computed(() => fold.value.sum / Math.max(1, fold.value.count))

const fmt = (value: number): string =>
  Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1)

// ------------------------------------------------------------------ drawing

const VIEW_W = 900
const VIEW_H = 168
const LEFT = 40
const RIGHT = 40
const FLOOR = 128

const scale = computed(() => {
  const top = Math.max(fold.value.max, 1) * 1.15
  return (value: number) => FLOOR - (value / top) * 92
})

const bars = computed(() => {
  const n = values.value.length
  const span = VIEW_W - LEFT - RIGHT
  const w = Math.min(64, (span - (n - 1) * 12) / n)
  const total = n * w + (n - 1) * 12
  const left = LEFT + (span - total) / 2

  return values.value.map((value, i) => {
    // One slow timing next to a fast one would otherwise leave nothing to see,
    // and that comparison is the point of the chart.
    const h = Math.max(3, FLOOR - scale.value(value))
    return {
      value,
      index: i,
      x: left + i * (w + 12),
      w,
      y: FLOOR - h,
      h,
      isLast: i === n - 1,
    }
  })
})

const columns = computed(() => ALL.filter((one) => stored.value.includes(one)))

const rowPreview = computed(() => {
  const parts = [
    `id: '4f2c18a6…'`,
    `bucket_ts: Date`,
    props.kind === 'timer' ? `route: '/checkout'` : `region: 'us-east'`,
    ...columns.value.map((name) => `${name}: ${fmt(fold.value[name])}`),
  ]
  return `{ ${parts.join(', ')} }`
})

const droppedNote = computed(() => {
  const missing = ALL.filter((one) => !stored.value.includes(one))
  return missing.length === 0 ? '' : missing.join(', ')
})

const canAverage = computed(() => stored.value.includes('sum') && stored.value.includes('count'))
</script>

<template>
  <section class="mh-play">
    <header class="mh-play__head">
      <h4 class="mh-play__title">Try it: what one bucket folds to</h4>
      <div class="mh-play__headActions">
        <button type="button" class="mh-play__mini" :disabled="values.length <= 1"
          @click="removeObservation">
          fewer
        </button>
        <button type="button" class="mh-play__mini" :disabled="values.length >= 8"
          @click="addObservation">
          more
        </button>
      </div>
    </header>

    <p class="mh-play__lede">
      Drag each observation. These are {{ values.length }}
      {{ props.kind === 'timer' ? 'timings' : 'observations' }} inside one bucket, and the five
      numbers below are everything MetricHouse keeps about them.
    </p>

    <figure class="mh-play__figure">
      <svg :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`" role="img"
        :aria-label="`Observations ${values.join(', ')} folding to min ${fold.min}, max ${fold.max}, sum ${fold.sum}, count ${fold.count}`">
        <line :x1="LEFT - 12" :y1="scale(fold.max)" :x2="VIEW_W - RIGHT + 12" :y2="scale(fold.max)"
          class="mh-play__guide" />
        <text :x="VIEW_W - RIGHT + 12" :y="scale(fold.max) - 5" text-anchor="end"
          class="mh-play__guideLabel">max {{ fmt(fold.max) }}</text>

        <line :x1="LEFT - 12" :y1="scale(fold.min)" :x2="VIEW_W - RIGHT + 12" :y2="scale(fold.min)"
          class="mh-play__guide" />
        <text :x="VIEW_W - RIGHT + 12" :y="scale(fold.min) + 14" text-anchor="end"
          class="mh-play__guideLabel">min {{ fmt(fold.min) }}</text>

        <line :x1="LEFT - 12" :y1="scale(average)" :x2="VIEW_W - RIGHT + 12" :y2="scale(average)"
          class="mh-play__guide mh-play__guide--derived" />
        <text :x="LEFT - 12" :y="scale(average) - 5" class="mh-play__guideLabel">
          average {{ fmt(average) }} · derived, never stored
        </text>

        <g v-for="bar in bars" :key="bar.index">
          <rect :x="bar.x" :y="bar.y" :width="bar.w" :height="bar.h" rx="4"
            class="mh-play__foldBar" :class="{ 'is-last': bar.isLast }" />
          <text :x="bar.x + bar.w / 2" :y="bar.y - 7" text-anchor="middle"
            class="mh-play__foldValue">{{ fmt(bar.value) }}</text>
          <text :x="bar.x + bar.w / 2" :y="FLOOR + 18" text-anchor="middle"
            class="mh-play__foldIndex">
            {{ bar.isLast ? 'last' : `#${bar.index + 1}` }}
          </text>
        </g>

        <line :x1="LEFT - 12" :y1="FLOOR" :x2="VIEW_W - RIGHT + 12" :y2="FLOOR"
          class="mh-play__floor" />
      </svg>
    </figure>

    <div class="mh-play__controls mh-play__controls--dense">
      <MhSlider
        v-for="(value, i) in values" :key="i" v-model="values[i]"
        :label="`observation ${i + 1}`"
        :min="0" :max="props.max" :step="Math.max(1, Math.round(props.max / 200))"
        :display="`${fmt(value)}${unit}`"
      />
    </div>

    <div class="mh-play__chips">
      <span class="mh-play__chipsLabel">aggregate:</span>
      <button v-for="name in ALL" :key="name" type="button" class="mh-play__chip"
        :class="{ 'is-on': stored.includes(name) }" :aria-pressed="stored.includes(name)"
        @click="toggleAggregate(name)">
        {{ name }}
      </button>
      <span class="mh-play__chipsHint">
        all five are always folded. This only picks which become columns.
      </span>
    </div>

    <div class="mh-play__rowbox">
      <span class="mh-play__rowboxLabel">the row your write function receives</span>
      <code class="mh-play__row">{{ rowPreview }}</code>
      <p v-if="droppedNote" class="mh-play__rowNote">
        {{ droppedNote }} {{ droppedNote.includes(',') ? 'are' : 'is' }} folded but not written.
        Widening this later needs no migration.
      </p>
      <p class="mh-play__rowNote" :class="{ 'is-warn': !canAverage }">
        <template v-if="canAverage">
          Average is <code>sum / count</code> = {{ fmt(average) }}, computed in SQL. It is not
          stored because an average cannot be merged across buckets.
        </template>
        <template v-else>
          Without both <code>sum</code> and <code>count</code> you cannot recover an average later.
        </template>
      </p>
    </div>
  </section>
</template>
