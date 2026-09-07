import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'metrichouse', environment: 'node', include: ['src/**/*.test.ts'] },
})
