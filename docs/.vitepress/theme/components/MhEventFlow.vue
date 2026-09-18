<script setup lang="ts">
import { computed, ref } from 'vue'
import { count, DAY_MS, FLUSHES, indexOf } from './duration'
import MhSlider from './MhSlider.vue'
import MhStat from './MhStat.vue'
import MhToggle from './MhToggle.vue'

const props = withDefaults(
  defineProps<{
    metric?: string
    kind?: 'event' | 'log'
  }>(),
  { metric: 'checkout_attempted', kind: 'event' },
)

const RATES = [1, 5, 10, 50, 100, 500, 1_000, 5_000, 20_000]
const SIZES = [1, 10, 50, 100, 250, 500, 1_000, 5_000, 10_000]
const AGES = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000]
const SAMPLES = [0, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1]

const stage = ref<'driver' | 'local'>('driver')
const rateIndex = ref(4)
const sizeIndex = ref(5)
const ageIndex = ref(3)
const sampleIndex = ref(7)
const flushIndex = ref(indexOf(FLUSHES, '30s', 3))

const rate = computed(() => RATES[rateIndex.value] ?? 100)
const maxSize = computed(() => SIZES[sizeIndex.value] ?? 500)
const maxAgeMs = computed(() => AGES[ageIndex.value] ?? 10_000)
const sample = computed(() => SAMPLES[sampleIndex.value] ?? 1)
const flushMs = computed(() => FLUSHES[flushIndex.value]?.ms ?? 30_000)

/** Sampling drops records before anything is staged. */
const kept = computed(() => rate.value * sample.value)

/** Local staging ships on whichever limit is reached first. */
const secondsToSize = computed(() => (kept.value === 0 ? Infinity : maxSize.value / kept.value))
const sizeWinsLocally = computed(() => secondsToSize.value * 1000 <= maxAgeMs.value)

const trigger = computed(() => {
  if (stage.value === 'driver') return 'flush'
  return sizeWinsLocally.value ? 'size' : 'age'
})

/** How long one batch waits before it leaves. */
const intervalMs = computed(() => {
  if (stage.value === 'driver') return flushMs.value
  return sizeWinsLocally.value ? secondsToSize.value * 1000 : maxAgeMs.value
})

const perBatch = computed(() => Math.max(1, Math.round((kept.value * intervalMs.value) / 1000)))
const shipsPerDay = computed(() => DAY_MS / intervalMs.value)
const rowsPerDay = computed(() => kept.value * 86_400)
const droppedPerDay = computed(() => (rate.value - kept.value) * 86_400)

/** How many records sit in the driver waiting, at any moment. */
const held = computed(() => perBatch.value)

const triggerText = computed(() => {
  if (stage.value === 'driver') {
    return `Records go to the driver and wait. Whatever calls flush() carries them, no more often than every ${FLUSHES[flushIndex.value]?.label}.`
  }
  return sizeWinsLocally.value
    ? `The buffer reaches maxSize (${maxSize.value}) after about ${fmtSeconds(secondsToSize.value)}, before maxAge does. Size is what ships it.`
    : `At this rate the buffer only reaches ${Math.round((kept.value * maxAgeMs.value) / 1000)} records before maxAge (${fmtSeconds(maxAgeMs.value / 1000)}) fires. Age is what ships it.`
})

function fmtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'never'
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 90) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  return `${Math.round(seconds / 60)}m`
}

// ------------------------------------------------------------------ drawing

const SLOTS = 24
const fillFraction = computed(() => {
  if (stage.value === 'driver') return 1
  return sizeWinsLocally.value
    ? 1
    : Math.min(1, (kept.value * maxAgeMs.value) / 1000 / maxSize.value)
})
const filledSlots = computed(() => Math.round(SLOTS * fillFraction.value))

const sampleSlots = computed(() => {
  // A visual sense of the drop rate: 20 arriving records, some greyed out.
  return Array.from({ length: 20 }, (_, i) => ({
    index: i,
    keptIn: sample.value >= 1 ? true : (i * 0.618033) % 1 < sample.value,
  }))
})

const snippet = computed(() =>
  [
    `${props.kind}('${props.metric}', {`,
    `  fields: { /* ... */ },`,
    `  stage: '${stage.value}',`,
    stage.value === 'local'
      ? `  batch: { maxSize: ${maxSize.value}, maxAge: '${fmtSeconds(maxAgeMs.value / 1000)}' },`
      : null,
    `  flush: '${FLUSHES[flushIndex.value]?.label}',`,
    sample.value < 1 && props.kind === 'event' ? `  sample: ${sample.value},` : null,
    `  write: async (rows) => db.insert(rows),`,
    `})`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n'),
)
</script>

<template>
  <section class="mh-play">
    <header class="mh-play__head">
      <h4 class="mh-play__title">Try it: where records wait, and what moves them</h4>
    </header>

    <div class="mh-play__controls">
      <MhToggle
        v-model="stage"
        label="stage"
        :options="[
          { value: 'driver', label: `'driver'` },
          { value: 'local', label: `'local'` },
        ]"
        hint="in the driver, or in this process"
      />
      <MhSlider v-model="rateIndex" label="records per second" :values="RATES"
        :display="count(rate)" hint="what your application produces" />
      <MhSlider v-if="props.kind === 'event'" v-model="sampleIndex" label="sample" :values="SAMPLES"
        :display="sample === 1 ? 'keep everything' : `${Math.round(sample * 100)}%`"
        hint="the fraction kept" />
      <MhSlider v-model="flushIndex" label="flush" :choices="FLUSHES"
        :disabled="stage === 'local'" hint="the fastest a flush may ship it" />
      <MhSlider v-model="sizeIndex" label="batch.maxSize" :values="SIZES"
        :disabled="stage === 'driver'" hint="local staging only" />
      <MhSlider v-model="ageIndex" label="batch.maxAge" :values="AGES"
        :display="fmtSeconds(maxAgeMs / 1000)" :disabled="stage === 'driver'"
        hint="local staging only" />
    </div>

    <figure v-if="props.kind === 'event'" class="mh-play__figure mh-play__figure--tight">
      <svg viewBox="0 0 900 58" role="img"
        :aria-label="`Sampling keeps ${Math.round(sample * 100)} percent of arriving records`">
        <text x="14" y="20" class="mh-play__axis">20 records arrive</text>
        <g v-for="slot in sampleSlots" :key="slot.index">
          <rect :x="14 + slot.index * 26" y="28" width="20" height="20" rx="4"
            class="mh-play__rec" :class="{ 'is-dropped': !slot.keptIn }" />
        </g>
        <text x="548" y="44" class="mh-play__axis">
          {{ sample === 1 ? 'all kept' : 'faded ones are dropped before anything is staged' }}
        </text>
      </svg>
    </figure>

    <figure class="mh-play__figure">
      <svg viewBox="0 0 900 128" role="img"
        :aria-label="`A queue holding about ${held} records, shipped by ${trigger}`">
        <rect x="14" y="26" width="620" height="54" rx="10" class="mh-play__queue" />
        <text x="24" y="18" class="mh-play__windowLabel">
          {{ stage === 'driver' ? 'waiting in the driver' : 'buffered in this process' }}
        </text>

        <g v-for="i in SLOTS" :key="i">
          <rect
            :x="26 + (i - 1) * 24" y="38" width="18" height="30" rx="3"
            class="mh-play__slot" :class="{ 'is-filled': i <= filledSlots }"
          />
        </g>

        <text x="324" y="98" text-anchor="middle" class="mh-play__note">
          about {{ count(held) }} records per batch
        </text>

        <line x1="644" y1="53" x2="700" y2="53" class="mh-play__arrow" marker-end="url(#mh-arrow)" />
        <text x="672" y="44" text-anchor="middle" class="mh-play__axis">{{ trigger }}</text>

        <rect x="708" y="26" width="178" height="54" rx="10" class="mh-play__sink" />
        <text x="797" y="50" text-anchor="middle" class="mh-play__sinkLabel">your write()</text>
        <text x="797" y="68" text-anchor="middle" class="mh-play__note">
          every {{ fmtSeconds(intervalMs / 1000) }}
        </text>

        <defs>
          <marker id="mh-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"
            markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" class="mh-play__arrowHead" />
          </marker>
        </defs>
      </svg>
      <figcaption>{{ triggerText }}</figcaption>
    </figure>

    <div class="mh-play__stats">
      <MhStat label="rows stored per day" :value="count(rowsPerDay)"
        :tone="rowsPerDay > 500_000_000 ? 'warn' : 'plain'" hint="after sampling" />
      <MhStat v-if="props.kind === 'event'" label="dropped per day" :value="count(droppedPerDay)"
        hint="sampling never touches a derived counter" />
      <MhStat label="writes per day" :value="count(shipsPerDay)" hint="calls to your database" />
      <MhStat label="records per write" :value="count(perBatch)"
        :tone="perBatch > 50_000 ? 'warn' : 'plain'"
        :hint="perBatch > 50_000 ? 'set claimLimit' : 'one insert this size'" />
    </div>

    <p v-if="stage === 'local'" class="mh-play__warn">
      Local staging holds these {{ count(held) }} records in this process only. A crash loses them,
      and a frozen serverless isolate never ships them. Right for page views, wrong for money.
    </p>

    <details class="mh-play__code">
      <summary>The declaration these settings produce</summary>
      <pre><code>{{ snippet }}</code></pre>
    </details>
  </section>
</template>
