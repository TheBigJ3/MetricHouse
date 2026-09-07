import { createHouse, redis } from 'metrichouse'
import { createClient } from 'redis'
import * as schema from './schema'

const client = createClient({ url: process.env.REDIS_URL })
await client.connect()

export const house = createHouse({
  driver: redis(client, { namespace: 'coldchain', claimTtl: '120s' }),
  schema,
  strict: process.env.NODE_ENV !== 'production',
  onError: (err, ctx) => console.error(`[mh] ${err.code} ${ctx.metric}`, err.message),
  onWarn: (warn, ctx) => console.warn(`[mh] ${warn.code} ${ctx.metric}`, warn.message),
})

// The #12 fix. Three constants, declared once in schema defaults, supplied
// once here, never repeated at a call site. Tollgate's biggest ergonomic
// complaint is simply gone.
house.bind({
  fleet: process.env.FLEET_ID ?? 'default',
  region: process.env.REGION ?? 'unknown',
  firmware: 'cloud',
})

setInterval(() => void house.flush({ rowBatch: 50_000, yieldBetweenBatches: true }), 30_000)

process.on('SIGTERM', async () => {
  await house.flush({ force: true, includeOpen: true })
  await house.close()
})
