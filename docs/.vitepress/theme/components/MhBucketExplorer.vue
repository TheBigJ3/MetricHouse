<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { count, DAY_MS, FLUSHES, GRACES, indexOf, noise, RESOLUTIONS } from './duration'
import MhSlider from './MhSlider.vue'
import MhStat from './MhStat.vue'

const props = withDefaults(
  defineProps<{
    /** Shown in the row preview and in the error text. */
    metric?: string
    kind?: 'counter' | 'gauge' | 'timer'
    resolution?: string
    flush?: string
    grace?: string
    /** How many distinct label combinations to start at. */
    series?: number
  }>(),
  {
    metric: 'http_requests',
    kind: 'counter',
    resolution: '10s',
    flush: '1m',
    grace: '2s',
    series: 12,
  },
)

const SERIES_STEPS = [1, 2, 4, 8, 12, 25, 50, 100, 250, 500, 1_000, 5_000, 25_000, 100_000]

const resolutionIndex = ref(indexOf(RESOLUTIONS, props.resolution, 6))
const flushIndex = ref(indexOf(FLUSHES, props.flush, 4))
const graceIndex = ref(indexOf(GRACES, props.grace, 3))
const seriesIndex = ref(Math.max(0, SERIES_STEPS.indexOf(props.series)))

const resolutionMs = computed(() => RESOLUTIONS[resolutionIndex.value]?.ms ?? 10_000)
const flushMs = computed(() => FLUSHES[flushIndex.value]?.ms ?? 60_000)
const graceMs = computed(() => GRACES[graceIndex.value]?.ms ?? 2_000)
const seriesCount = computed(() => SERIES_STEPS[seriesIndex.value] ?? 1)

const resolutionLabel = computed(() => RESOLUTIONS[resolutionIndex.value]?.label ?? '')
const flushLabel = computed(() => FLUSHES[flushIndex.value]?.label ?? '')
const graceLabel = computed(() => GRACES[graceIndex.value]?.label ?? '')

/** The library refuses a cadence a resolution does not divide. So does this. */
const valid = computed(() => flushMs.value % resolutionMs.value === 0)

const bucketsPerFlush = computed(() => (valid.value ? flushMs.value / resolutionMs.value : 0))
const rowsPerFlush = computed(() => bucketsPerFlush.value * seriesCount.value)
const rowsPerDay = computed(() => (DAY_MS / resolutionMs.value) * seriesCount.value)
const flushesPerDay = computed(() => DAY_MS / flushMs.value)

/** The nearest cadence in the list that this resolution does divide. */
const nearestValid = computed(() => {
  let best = -1
  let bestGap = Number.POSITIVE_INFINITY
  FLUSHES.forEach((one, i) => {
    if (one.ms % resolutionMs.value !== 0) return
    const gap = Math.abs(one.ms - flushMs.value)
    if (gap < bestGap) {
      bestGap = gap
      best = i
    }
  })
  return best
})

function snap(): void {
  if (nearestValid.value !== -1) flushIndex.value = nearestValid.value
}

// ---------------------------------------------------------------- the drawing

const VIEW_W = 900
const VIEW_H = 196
const PAD = 16
const GAP = 16
const WINDOW_W = (VIEW_W - PAD * 2 - GAP) / 2
const TOP = 46
const BAND_H = 74
/** Beyond this, cells stop being individually readable and we summarise. */
const MAX_CELLS = 22

const shownCells = computed(() => Math.min(bucketsPerFlush.value, MAX_CELLS))
const truncated = computed(() => bucketsPerFlush.value > MAX_CELLS)

interface Cell {
  x: number
  w: number
  barH: number
  index: number
}

function cellsFor(windowIndex: number): Cell[] {
  const n = shownCells.value
  if (n <= 0) return []

  const inner = WINDOW_W - 16
  const gap = n > 14 ? 2 : 4
  const w = (inner - gap * (n - 1)) / n
  const left = PAD + windowIndex * (WINDOW_W + GAP) + 8

  return Array.from({ length: n }, (_, i) => ({
    x: left + i * (w + gap),
    w,
    barH: 8 + noise(i + windowIndex * 97 + resolutionIndex.value * 13) * 40,
    index: i,
  }))
}

const windows = computed(() => [
  { x: PAD, cells: cellsFor(0) },
  { x: PAD + WINDOW_W + GAP, cells: cellsFor(1) },
])

// ---------------------------------------------------------------- the playhead

const playing = ref(false)
/** 0 to 2: how many flush windows the playhead has swept. */
const progress = ref(0)
let handle: ReturnType<typeof setInterval> | undefined

/** One sweep of both windows takes this long, whatever the cadence is. */
const SWEEP_MS = 7_000
const STEP_MS = 60

function tick(): void {
  progress.value = (progress.value + (2 * STEP_MS) / SWEEP_MS) % 2.0001
}

function toggle(): void {
  playing.value = !playing.value
  if (!playing.value) progress.value = 0
}

onMounted(() => {
  handle = setInterval(() => {
    if (playing.value) tick()
  }, STEP_MS)
})

onBeforeUnmount(() => {
  if (handle) clearInterval(handle)
})

/** Where the playhead sits, in view units. */
const playheadX = computed(() => {
  const windowIndex = Math.min(1, Math.floor(progress.value))
  const within = progress.value - windowIndex
  return PAD + windowIndex * (WINDOW_W + GAP) + within * WINDOW_W
})

/** A cell is filled once the playhead has passed it. */
function filled(windowIndex: number, cell: Cell): boolean {
  if (!playing.value) return true
  const cellEnd = cell.x + cell.w
  return playheadX.value >= cellEnd || progress.value >= windowIndex + 1
}

/** A window flashes once the playhead has left it. */
function shipped(windowIndex: number): boolean {
  return playing.value && progress.value >= windowIndex + 1
}

// ------------------------------------------------------- grace detail strip

const GRACE_W = 560
const graceShare = computed(() => {
  const total = resolutionMs.value + graceMs.value
  return total === 0 ? 0 : graceMs.value / total
})
const graceBarW = computed(() => Math.round(GRACE_W * graceShare.value))
const bucketBarW = computed(() => GRACE_W - graceBarW.value)

// ---------------------------------------------------------------- row preview

const valueColumns = computed(() =>
  props.kind === 'counter' ? ['value'] : ['min', 'max', 'sum', 'count'],
)

const snippet = computed(() => {
  const fn = props.kind
  return [
    `${fn}('${props.metric}', {`,
    `  resolution: '${resolutionLabel.value}',`,
    `  flush: '${flushLabel.value}',`,
    graceLabel.value === '2s' ? null : `  grace: '${graceLabel.value}',`,
    `  write: async (rows) => db.insert(rows),`,
    `})`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
})
</script>

<template>
  <section class="mh-play">
    <header class="mh-play__head">
      <h4 class="mh-play__title">Try it: resolution inside flush</h4>
      <button type="button" class="mh-play__play" :class="{ 'is-on': playing }" @click="toggle">
        {{ playing ? 'Stop' : 'Run the clock' }}
      </button>
    </header>

    <div class="mh-play__controls">
      <MhSlider v-model="resolutionIndex" label="resolution" :choices="RESOLUTIONS"
        hint="how wide one bucket is" />
      <MhSlider v-model="flushIndex" label="flush" :choices="FLUSHES"
        hint="the fastest this metric may ship" />
      <MhSlider v-model="graceIndex" label="grace" :choices="GRACES"
        hint="how long a late write still lands" />
      <MhSlider v-model="seriesIndex" label="label combinations" :values="SERIES_STEPS"
        :display="count(seriesCount)" hint="one row each, per bucket" />
    </div>

    <p v-if="!valid" class="mh-play__error">
      <strong>This is rejected at declaration time.</strong>
      <code>
        assertResolution: resolution {{ resolutionLabel }} does not divide flush
        {{ flushLabel }} evenly - a shipment would split a bucket
      </code>
      <button v-if="nearestValid !== -1" type="button" class="mh-play__fix" @click="snap">
        Snap flush to {{ FLUSHES[nearestValid]?.label }}
      </button>
    </p>

    <figure v-else class="mh-play__figure">
      <svg :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`" role="img"
        :aria-label="`One flush of ${flushLabel} carries ${bucketsPerFlush} buckets of ${resolutionLabel}`">
        <g v-for="(win, w) in windows" :key="w">
          <rect
            :x="win.x" :y="TOP - 22" :width="WINDOW_W" :height="BAND_H + 26" rx="10"
            class="mh-play__window" :class="{ 'is-shipped': shipped(w) }"
          />
          <text :x="win.x + 10" :y="TOP - 30" class="mh-play__windowLabel">
            flush window {{ w + 1 }} · {{ flushLabel }}
          </text>
          <text :x="win.x + WINDOW_W - 10" :y="TOP - 30" text-anchor="end"
            class="mh-play__shipLabel" :class="{ 'is-shipped': shipped(w) }">
            {{ shipped(w) ? `shipped ${count(rowsPerFlush)} rows` : '' }}
          </text>

          <g v-for="cell in win.cells" :key="cell.index">
            <rect
              :x="cell.x" :y="TOP" :width="cell.w" :height="BAND_H" rx="3"
              class="mh-play__cell"
            />
            <rect
              v-if="filled(w, cell)"
              :x="cell.x + 1" :y="TOP + BAND_H - cell.barH - 2"
              :width="Math.max(1, cell.w - 2)" :height="cell.barH" rx="2"
              class="mh-play__bar"
            />
          </g>

          <text v-if="truncated" :x="win.x + WINDOW_W / 2" :y="TOP + BAND_H + 18"
            text-anchor="middle" class="mh-play__note">
            showing {{ MAX_CELLS }} of {{ count(bucketsPerFlush) }} buckets
          </text>
          <text v-else :x="win.x + WINDOW_W / 2" :y="TOP + BAND_H + 18" text-anchor="middle"
            class="mh-play__note">
            {{ bucketsPerFlush }} × {{ resolutionLabel }}
          </text>
        </g>

        <line
          v-if="playing" :x1="playheadX" :y1="TOP - 26" :x2="playheadX" :y2="TOP + BAND_H + 6"
          class="mh-play__playhead"
        />

        <text :x="PAD" :y="VIEW_H - 8" class="mh-play__axis">
          one bucket = {{ resolutionLabel }}
        </text>
        <text :x="VIEW_W - PAD" :y="VIEW_H - 8" text-anchor="end" class="mh-play__axis">
          time
        </text>
      </svg>
      <figcaption>
        Each outer box is one flush. Every bucket inside it ships together, in one call to your
        write function.
      </figcaption>
    </figure>

    <figure v-if="valid" class="mh-play__figure mh-play__figure--tight">
      <svg viewBox="0 0 900 62" role="img"
        :aria-label="`A bucket of ${resolutionLabel} followed by ${graceLabel} of grace`">
        <rect x="170" y="14" :width="bucketBarW" height="30" rx="6" class="mh-play__graceBucket" />
        <text :x="170 + bucketBarW / 2" y="34" text-anchor="middle" class="mh-play__graceText">
          bucket {{ resolutionLabel }}
        </text>
        <rect
          v-if="graceBarW > 0" :x="170 + bucketBarW" y="14" :width="graceBarW" height="30" rx="6"
          class="mh-play__graceTail"
        />
        <text
          v-if="graceBarW > 34" :x="170 + bucketBarW + graceBarW / 2" y="34" text-anchor="middle"
          class="mh-play__graceText"
        >
          grace {{ graceLabel }}
        </text>
        <text x="170" y="58" class="mh-play__axis">
          a write arriving inside either band lands in this bucket
        </text>
      </svg>
    </figure>

    <div class="mh-play__stats">
      <MhStat label="buckets per flush" :value="valid ? String(bucketsPerFlush) : '—'"
        hint="rows arrive together" />
      <MhStat label="rows per flush" :value="valid ? count(rowsPerFlush) : '—'"
        hint="buckets × combinations" :tone="rowsPerFlush > 100_000 ? 'warn' : 'plain'" />
      <MhStat label="rows per day" :value="count(rowsPerDay)"
        hint="what your table stores" :tone="rowsPerDay > 100_000_000 ? 'warn' : 'plain'" />
      <MhStat label="writes per day" :value="count(flushesPerDay)"
        hint="calls to your database" />
    </div>

    <details class="mh-play__code">
      <summary>The declaration these settings produce</summary>
      <pre><code>{{ snippet }}</code></pre>
      <p class="mh-play__codeNote">
        Your sink receives
        <code>{{ ['id', 'bucket_ts', '…dims', ...valueColumns].join(', ') }}</code>,
        one row per combination per bucket.
      </p>
    </details>
  </section>
</template>
