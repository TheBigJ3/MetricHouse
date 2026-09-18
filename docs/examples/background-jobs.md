# Background jobs

A worker process that runs queued jobs, measuring throughput, duration and
failures.

## The schema

```ts
// metrics/schema.ts
import { counter, event, float, gauge, int, json, log, oneOf, str, timer } from 'metrichouse/core'
import { toClickHouse } from './sinks.js'

const JOB_TYPES = ['send_email', 'generate_report', 'sync_contacts', 'process_upload'] as const
const OUTCOMES = ['completed', 'failed', 'timed_out'] as const

// How many jobs ran, and how they ended.
export const jobsRun = counter('jobs_run', {
  dims: {
    jobType: oneOf(JOB_TYPES),
    outcome: oneOf(OUTCOMES),
  },
  resolution: '1m',
  flush: '1m',
  write: toClickHouse('jobs_run'),
})

// How long each one took.
export const jobDuration = timer('job_duration', {
  dims: {
    jobType: oneOf(JOB_TYPES),
    outcome: oneOf(OUTCOMES),
  },
  resolution: '1m',
  flush: '1m',

  // Some jobs take minutes. Give a late write room to land.
  grace: '30s',

  record: 'job_duration_samples',
  write: toClickHouse('job_duration'),
})

export const jobDurationSamples = event('job_duration_samples', {
  fields: {
    ...jobDuration.dims,
    duration_ms: float(),
  },
  // Job volume is low enough to keep everything.
  flush: '1m',
  write: toClickHouse('job_duration_samples'),
})

// How deep the queue is. Sampled on a timer, not counted.
export const queueDepth = gauge('queue_depth', {
  dims: { queue: str() },
  resolution: '1m',
  flush: '1m',
  write: toClickHouse('queue_depth'),
})

// Everything about one failure, for the postmortem.
export const jobFailed = event('job_failed', {
  fields: {
    jobId: str(),
    jobType: oneOf(JOB_TYPES),
    attempt: int(),
    errorName: str(),
    errorMessage: str(),
    errorStack: str().optional(),
    payload: json<Record<string, unknown>>().optional(),
  },

  // Durable staging. A worker that crashes should not take its failure
  // records with it.
  stage: 'driver',
  flush: '10s',

  // Every failure also increments the counter, so the two cannot disagree.
  derive: {
    jobs_run: (fields) => ({ dims: { jobType: fields.jobType, outcome: 'failed' as const } }),
  },

  write: toClickHouse('job_failed'),
})

export const workerLog = log('worker_log', {
  fields: { worker: str(), jobId: str().optional(), jobType: str().optional() },
  minLevel: 'info',
  flush: '10s',
  write: toClickHouse('worker_log'),
})
```

## The house

```ts
// metrics/house.ts
import { createHouse } from 'metrichouse/core'
import { ioredis } from 'metrichouse/ioredis'
import Redis from 'ioredis'
import * as schema from './schema.js'
import { logger } from '../logger.js'

// The queue already runs on Redis, so reuse the connection details.
export const house = createHouse({
  driver: ioredis(() => new Redis(process.env.REDIS_URL!), { namespace: 'metrics' }),
  schema,
  defaults: { flush: '1m', grace: '10s' },
  onError: (error, { metric }) => logger.error({ err: error, metric }, 'metric failed'),
  onWarn: (message) => logger.warn({ message }, 'metrichouse'),
})
```

A different `namespace` keeps the metric keys clearly separate from the queue's
own keys in the same Redis.

## The worker

```ts
// worker.ts
import { jobDuration, jobFailed, jobsRun, workerLog } from './metrics/schema.js'
import { house } from './metrics/house.js'

const worker = process.env.HOSTNAME ?? 'worker-local'

async function runJob(job: Job) {
  const log = workerLog.child({ worker, jobId: job.id, jobType: job.type })

  // The outcome is not known yet, so only the type is bound here.
  const span = jobDuration.start({ jobType: job.type })

  log.info('job started')

  try {
    await withTimeout(handlers[job.type](job.payload), job.timeoutMs)

    jobsRun.add({ jobType: job.type, outcome: 'completed' })
    const durationMs = span.end({ outcome: 'completed' })

    log.info('job completed')

    if (durationMs > job.timeoutMs * 0.8) {
      log.warn('job close to its timeout')
    }
  } catch (error) {
    const timedOut = error instanceof TimeoutError
    const outcome = timedOut ? 'timed_out' : 'failed'

    // The timer records whatever happened, including failures. A job that runs
    // for thirty seconds and then dies is exactly the duration you need to see.
    span.end({ outcome })

    if (timedOut) {
      // A timeout is not a failure record, so count it directly.
      jobsRun.add({ jobType: job.type, outcome: 'timed_out' })
    } else {
      // jobs_run is incremented by derive, so no add() here.
      jobFailed.record({
        jobId: job.id,
        jobType: job.type,
        attempt: job.attempt,
        errorName: (error as Error).name,
        errorMessage: (error as Error).message,
        errorStack: (error as Error).stack,
        payload: job.payload,
      })
    }

    log.error(error as Error)
    throw error
  }
}
```

The one thing worth noticing: `jobs_run` is incremented in two different ways
depending on the path, and in the failure path it happens through `derive` rather
than a direct call. That is deliberate. One fact is recorded once, and the counter
follows from it.

## Sampling the queue

```ts
// metrics/sampler.ts
import { queueDepth } from './schema.js'
import { queues } from '../queues.js'

export function startSampling() {
  const handle = setInterval(async () => {
    for (const queue of queues) {
      // Write a zero rather than skipping. A missing observation and a zero
      // look the same in a chart, and only one of them is true.
      queueDepth.set(await queue.size(), { queue: queue.name })
    }
  }, 10_000)

  handle.unref()
  return () => clearInterval(handle)
}
```

## Running it

```ts
// index.ts
import { house } from './metrics/house.js'
import { startSampling } from './metrics/sampler.js'
import { startWorker } from './worker.js'

const stopWorker = startWorker()
const stopSampling = startSampling()

house.start()

async function shutdown() {
  // Stop taking new jobs, let the current ones finish, then flush.
  await stopWorker()
  stopSampling()
  await house.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

Order matters at shutdown. Stop the worker first so no job records a metric after
the final flush.

## Health check

```ts
// A liveness endpoint that shows what the worker is doing right now.
app.get('/health', async (_req, res) => {
  const [depths, running, failures] = await Promise.all([
    queueDepth.snapshot({ complete: false, rollup: 'sum', groupBy: ['queue'] }),
    jobsRun.current(),
    jobFailed.pending(),
  ])

  res.json({
    queues: depths,
    jobsThisMinute: running,

    // A growing backlog here means flushes are failing, not that jobs are.
    unshippedFailureRecords: failures,
  })
})
```

## Queries

```sql
-- Success rate per job type, per hour.
SELECT
  toStartOfHour(bucket_ts)              AS hour,
  jobType,
  sum(value)                            AS total,
  sumIf(value, outcome = 'completed')   AS completed,
  completed / total                     AS success_rate
FROM jobs_run
WHERE bucket_ts >= now() - INTERVAL 1 DAY
GROUP BY hour, jobType
ORDER BY success_rate ASC;
```

```sql
-- Which job types are slowest, and whether failures are slower than successes.
SELECT
  jobType,
  outcome,
  sum(count)            AS runs,
  sum(sum) / sum(count) AS avg_ms,
  max(max)              AS slowest_ms
FROM job_duration
WHERE bucket_ts >= now() - INTERVAL 1 DAY
GROUP BY jobType, outcome
ORDER BY avg_ms DESC;
```

```sql
-- The most common failures, grouped by error.
SELECT
  jobType,
  errorName,
  errorMessage,
  count()     AS failures,
  max(attempt) AS worst_attempt
FROM job_failed
WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY jobType, errorName, errorMessage
ORDER BY failures DESC
LIMIT 20;
```

```sql
-- Queue depth over time, to see whether workers keep up.
SELECT
  toStartOfMinute(bucket_ts) AS minute,
  queue,
  max(max)                   AS peak_depth,
  sum(sum) / sum(count)      AS avg_depth
FROM queue_depth
WHERE bucket_ts >= now() - INTERVAL 6 HOUR
GROUP BY minute, queue
ORDER BY minute;
```
