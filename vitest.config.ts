import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Explicit config paths, not bare directory globs: a bare `packages/*`
    // matches `packages/README.md` and vitest refuses to start.
    projects: ['packages/*/vitest.config.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text', 'lcov'],
    },
  },
})
