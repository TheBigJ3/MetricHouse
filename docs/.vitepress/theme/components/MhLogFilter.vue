<script setup lang="ts">
import { computed, ref } from 'vue'
import { count } from './duration'
import MhSlider from './MhSlider.vue'
import MhStat from './MhStat.vue'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
type Level = (typeof LEVELS)[number]

/** Lines a minute at each level, which is roughly how a real service behaves. */
const RATES = [2000, 400, 30, 4]

const minIndex = ref(1)
const rates = ref<number[]>([...RATES])
/** Average serialised size of one line, in bytes. */
const bytes = ref(320)

const minLevel = computed<Level>(() => LEVELS[minIndex.value] ?? 'info')

const perLevel = computed(() =>
  LEVELS.map((level, i) => ({
    level,
    rate: rates.value[i] ?? 0,
    keptIn: i >= minIndex.value,
  })),
)

const keptPerMinute = computed(() =>
  perLevel.value.reduce((total, one) => total + (one.keptIn ? one.rate : 0), 0),
)
const droppedPerMinute = computed(() =>
  perLevel.value.reduce((total, one) => total + (one.keptIn ? 0 : one.rate), 0),
)
const totalPerMinute = computed(() => keptPerMinute.value + droppedPerMinute.value)

const keptPerDay = computed(() => keptPerMinute.value * 1_440)
const bytesPerDay = computed(() => keptPerDay.value * bytes.value)

function gb(value: number): string {
  if (value < 1_000_000) return `${(value / 1_000).toFixed(0)} KB`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`
  return `${(value / 1_000_000_000).toFixed(1)} GB`
}

// ------------------------------------------------------------------ drawing

const BAR_W = 860
const bars = computed(() => {
  const total = Math.max(1, totalPerMinute.value)
  let x = 20
  return perLevel.value.map((one) => {
    const w = (one.rate / total) * BAR_W
    const bar = { ...one, x, w }
    x += w
    return bar
  })
})

const SAMPLE_LINES: { level: Level; message: string }[] = [
  { level: 'debug', message: 'cache lookup for user u_4821' },
  { level: 'info', message: 'request completed' },
  { level: 'debug', message: 'connection returned to pool' },
  { level: 'warn', message: 'payment processor slow' },
  { level: 'info', message: 'order created' },
  { level: 'error', message: 'card declined by issuer' },
]

function isKept(level: Level): boolean {
  return LEVELS.indexOf(level) >= minIndex.value
}

const snippet = computed(() =>
  [
    `log('app_log', {`,
    `  fields: { service: str() },`,
    `  levels: ['debug', 'info', 'warn', 'error'],`,
    `  minLevel: '${minLevel.value}',`,
    `  flush: '10s',`,
    `  write: async (rows) => s3.put(rows),`,
    `})`,
  ].join('\n'),
)
</script>

<template>
  <section class="mh-play">
    <header class="mh-play__head">
      <h4 class="mh-play__title">Try it: what minLevel actually costs you</h4>
    </header>

    <div class="mh-play__controls">
      <MhSlider v-model="minIndex" label="minLevel" :values="[0, 1, 2, 3]"
        :display="minLevel" hint="anything below this never reaches the driver" />
      <MhSlider v-model="bytes" label="bytes per line" :min="80" :max="2000" :step="20"
        :display="`${bytes} B`" hint="a rough serialised size" />
      <MhSlider v-for="(level, i) in LEVELS" :key="level" v-model="rates[i]"
        :label="`${level} lines per minute`" :min="0" :max="5000" :step="10"
        :display="count(rates[i] ?? 0)" />
    </div>

    <figure class="mh-play__figure">
      <svg viewBox="0 0 900 118" role="img"
        :aria-label="`${count(keptPerMinute)} of ${count(totalPerMinute)} lines a minute are kept at minLevel ${minLevel}`">
        <text x="20" y="20" class="mh-play__windowLabel">
          {{ count(totalPerMinute) }} lines a minute, before filtering
        </text>
        <g v-for="bar in bars" :key="bar.level">
          <rect :x="bar.x" y="30" :width="Math.max(0, bar.w - 2)" height="40" rx="5"
            class="mh-play__levelBar" :class="[`is-${bar.level}`, { 'is-dropped': !bar.keptIn }]" />
          <text v-if="bar.w > 64" :x="bar.x + bar.w / 2" y="55" text-anchor="middle"
            class="mh-play__levelText" :class="{ 'is-dropped': !bar.keptIn }">
            {{ bar.level }} {{ count(bar.rate) }}
          </text>
        </g>
        <text x="20" y="92" class="mh-play__axis">
          kept: {{ count(keptPerMinute) }} a minute
        </text>
        <text x="880" y="92" text-anchor="end" class="mh-play__axis">
          dropped before validation: {{ count(droppedPerMinute) }} a minute
        </text>
        <text x="20" y="110" class="mh-play__note">
          A dropped line costs one array index. No record is built, no field is checked.
        </text>
      </svg>
    </figure>

    <div class="mh-play__lines">
      <div v-for="(line, i) in SAMPLE_LINES" :key="i" class="mh-play__line"
        :class="{ 'is-dropped': !isKept(line.level) }">
        <span class="mh-play__lineLevel" :class="`is-${line.level}`">{{ line.level }}</span>
        <span class="mh-play__lineMessage">{{ line.message }}</span>
        <span class="mh-play__lineFate">{{ isKept(line.level) ? 'stored' : 'dropped' }}</span>
      </div>
    </div>

    <div class="mh-play__stats">
      <MhStat label="lines stored per day" :value="count(keptPerDay)"
        :tone="keptPerDay > 50_000_000 ? 'warn' : 'plain'" />
      <MhStat label="storage per day" :value="gb(bytesPerDay)"
        :tone="bytesPerDay > 50_000_000_000 ? 'warn' : 'plain'" hint="uncompressed" />
      <MhStat label="storage per month" :value="gb(bytesPerDay * 30)" hint="set a TTL on the table" />
      <MhStat label="dropped per day" :value="count(droppedPerMinute * 1440)"
        hint="never leaves your process" />
    </div>

    <details class="mh-play__code">
      <summary>The declaration these settings produce</summary>
      <pre><code>{{ snippet }}</code></pre>
    </details>
  </section>
</template>
