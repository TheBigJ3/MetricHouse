/**
 * metrichouse/ioredis — shared, durable storage over an `ioredis` client.
 *
 * `ioredis` is an **optional** peer dependency: importing this entry point is
 * what requires it, and an app on `metrichouse/memory` never installs it.
 */
export {
  type IoredisClient,
  type IoredisDriver,
  type IoredisDriverOptions,
  type IoredisPipeline,
  type IoredisSource,
  ioredis,
} from './drivers/ioredis.js'
