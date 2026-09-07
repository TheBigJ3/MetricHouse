import type { Usage } from './types'

type Kind = 'input' | 'output' | 'cached_read' | 'cached_write'

/** USD per token, per model, per kind. Returns a float — see FLAW 01. */
export function priceFor(model: string, kind: Kind, usage: Usage): number {
  const rate = RATES[model]?.[kind] ?? 0
  const n =
    kind === 'input' ? usage.input :
    kind === 'output' ? usage.output :
    kind === 'cached_read' ? usage.cachedRead : usage.cachedWrite
  return n * rate
}

const RATES: Record<string, Record<Kind, number>> = {}
