import { defineConfig } from 'tsdown'

// Entry points are added together with the code behind them, never ahead of it:
// an `exports` entry that resolves to an empty module is worse than an absent
// one, because a consumer importing it gets nothing and no error.
export default defineConfig({
  entry: ['src/index.ts', 'src/core.ts', 'src/memory.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
})
