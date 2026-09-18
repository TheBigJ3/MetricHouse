/**
 * metrichouse/memory — full driver parity in plain Maps.
 *
 * Legitimate for a long-lived single process. Rejected under
 * `runtime: 'serverless' | 'edge'`, where nothing can drain it.
 */
export { type MemoryDriverOptions, memory } from './drivers/memory.js'
