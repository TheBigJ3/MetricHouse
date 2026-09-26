import { afterEach, describe, expect, it, vi } from 'vitest'
import { getHasher, hash, naturalKey, rowId, setHasher, uuidv7 } from './identity.js'
import { oneOf, str } from './schema/types.js'

describe('hash', () => {
  it('is 32 lowercase hex characters', () => {
    expect(hash(['dog_poops', '1788616987000', 'Willow|riverside'])).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic', () => {
    const parts = ['dog_poops', '1788616987000', 'Willow|riverside|solid']
    expect(hash(parts)).toBe(hash([...parts]))
  })

  it('separates parts, so the boundary is real, not a join', () => {
    // if parts were concatenated these would be identical, and a metric name
    // ending in a separator could impersonate a dim value
    expect(hash(['a', 'bc'])).not.toBe(hash(['ab', 'c']))
    expect(hash(['a', ''])).not.toBe(hash(['', 'a']))
    expect(hash(['a'])).not.toBe(hash(['a', '']))
  })

  it('handles empty input', () => {
    expect(hash([])).toMatch(/^[0-9a-f]{32}$/)
    expect(hash([''])).toMatch(/^[0-9a-f]{32}$/)
    expect(hash([])).not.toBe(hash(['']))
  })

  it('handles unicode', () => {
    expect(hash(['🐕'])).toMatch(/^[0-9a-f]{32}$/)
    expect(hash(['🐕'])).not.toBe(hash(['🐈']))
    expect(hash(['café'])).not.toBe(hash(['cafe']))
  })

  it('does not produce four identical lanes', () => {
    // a construction bug that correlated the lanes would still pass every
    // determinism test above while throwing away 96 bits
    const h = hash(['dog_poops', '1788616987000', 'Willow'])
    const lanes = [h.slice(0, 8), h.slice(8, 16), h.slice(16, 24), h.slice(24, 32)]
    expect(new Set(lanes).size).toBe(4)
  })

  it('avalanches, so one changed character moves most of the output', () => {
    const toBits = (hex: string) =>
      [...hex].map((c) => Number.parseInt(c, 16).toString(2).padStart(4, '0')).join('')

    let totalDiff = 0
    const samples = 64
    for (let i = 0; i < samples; i++) {
      const a = toBits(hash(['m', String(1_788_616_987_000 + i)]))
      const b = toBits(hash(['m', String(1_788_616_987_000 + i + 1)]))
      totalDiff += [...a].filter((bit, j) => bit !== b[j]).length
    }

    // ideal is 64 of 128 bits; anything above 45 rules out a broken mixer
    expect(totalDiff / samples).toBeGreaterThan(45)
  })

  it('has no collisions across 200k realistic keys', () => {
    const seen = new Set<string>()
    let count = 0
    for (let metric = 0; metric < 20; metric++) {
      for (let bucket = 0; bucket < 100; bucket++) {
        for (let dim = 0; dim < 100; dim++) {
          seen.add(
            hash([
              `metric_${metric}`,
              String(1_788_616_987_000 + bucket * 1000),
              `dog_${dim}|park_${dim % 7}|solid`,
            ]),
          )
          count++
        }
      }
    }
    expect(seen.size).toBe(count)
  })
})

describe('rowId', () => {
  it('is stable across calls, the whole at-least-once story', () => {
    // the same bucket shipped twice, because flush crashed before ack
    const first = rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside|solid')
    const second = rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside|solid')
    expect(first).toBe(second)
  })

  it('carries no state from the flush that produced it', () => {
    const id = rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside|solid')
    for (let i = 0; i < 5; i++) {
      expect(rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside|solid')).toBe(id)
    }
  })

  it('differs on metric, bucket, or dims', () => {
    const base = rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside')
    expect(rowId('walk_started', 1_788_616_987_000, 'Willow|riverside')).not.toBe(base)
    expect(rowId('dog_poops', 1_788_616_988_000, 'Willow|riverside')).not.toBe(base)
    expect(rowId('dog_poops', 1_788_616_987_000, 'Willow|central')).not.toBe(base)
  })

  it('gives adjacent buckets unrelated ids', () => {
    const a = rowId('dog_poops', 1_788_616_987_000, 'Willow')
    const b = rowId('dog_poops', 1_788_616_988_000, 'Willow')
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8))
  })

  it('is 32 hex characters', () => {
    expect(rowId('m', 0, '')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps the exact ids rows already in a database carry', () => {
    // minted by the hasher as it shipped, before its hex encoding was
    // rewritten. A single changed character here means every stored row
    // would stop matching its resend
    expect(hash([])).toBe('11fd02eb9bb311159b518c6d8c03471f')
    expect(hash([''])).toBe('25dfb1fdb8449237291eb3d2a64d8578')
    expect(hash(['a', 'bc'])).toBe('74a03abd8d8abbb8429eaff394f14d79')
    expect(hash(['ab', 'c'])).toBe('7eef28c8227346ba2ede6a1bbac18131')
    expect(hash(['queue_depth', '🚀', 'é|ü'])).toBe('9b77707a0d373e729ffba368b84a93b7')
    expect(rowId('http_requests', 1_788_616_980_000, '/checkout|GET|200')).toBe(
      '829a217bb9424ef426b1f16c9123e3e4',
    )
    expect(rowId('q', 0, '')).toBe('9440568f4051c3c525272b23800f2cdd')
  })

  it('pads a lane whose value starts with zero bits to eight characters', () => {
    // each of these has a lane below 0x10000000, the case a byte table and
    // a padded toString could disagree on
    expect(rowId('pad', 1_788_618_534_000, 'x')).toBe('8e94baa8b52dc6d1c918bbe9000e66e6')
    expect(rowId('pad', 1_788_618_668_000, 'x')).toBe('8a2063dead5f24b77d42803b000e8b10')
  })
})

describe('naturalKey', () => {
  it('is bucket_ts followed by dims in declaration order', () => {
    const dims = { dogName: str(), park: str(), kind: oneOf(['solid', 'liquid']) }
    expect(naturalKey(dims)).toEqual(['bucket_ts', 'dogName', 'park', 'kind'])
  })

  it('is just bucket_ts for a metric with no dims', () => {
    expect(naturalKey({})).toEqual(['bucket_ts'])
  })

  it('follows declaration order, not alphabetical', () => {
    expect(naturalKey({ z: str(), a: str() })).toEqual(['bucket_ts', 'z', 'a'])
  })
})

describe('setHasher', () => {
  const original = getHasher()
  afterEach(() => {
    setHasher(original)
  })

  it('swaps the hasher and returns the previous one', () => {
    const previous = setHasher(() => 'stub')
    expect(previous).toBe(original)
    expect(rowId('m', 0, '')).toBe('stub')
  })

  it('receives the same parts rowId would hash', () => {
    let seen: string[] = []
    setHasher((parts) => {
      seen = parts
      return 'x'
    })
    rowId('dog_poops', 1_788_616_987_000, 'Willow|riverside')
    expect(seen).toEqual(['dog_poops', '1788616987000', 'Willow|riverside'])
  })

  it('restores cleanly', () => {
    const before = rowId('m', 1, 'a')
    setHasher(() => 'stub')
    setHasher(original)
    expect(rowId('m', 1, 'a')).toBe(before)
  })
})

describe('uuidv7', () => {
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('is a well-formed v7 uuid', () => {
    expect(uuidv7(1_788_616_987_000)).toMatch(V7)
  })

  it('encodes the timestamp in the leading 48 bits', () => {
    const ms = 1_788_616_987_000
    const hex = uuidv7(ms).replaceAll('-', '').slice(0, 12)
    expect(Number.parseInt(hex, 16)).toBe(ms)
  })

  it('survives a timestamp above 2^32 without shifting the high bytes away', () => {
    // a 32-bit shift would silently drop them, and every id after 1970 + 49
    // days would carry the wrong day
    const ms = 2_000_000_000_000
    const hex = uuidv7(ms).replaceAll('-', '').slice(0, 12)
    expect(Number.parseInt(hex, 16)).toBe(ms)
  })

  it('never repeats inside one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_788_616_987_000))
    expect(new Set(ids).size).toBe(5000)
  })

  it('sorts ascending inside one millisecond', () => {
    // the monotonic counter, not the random bits, is what guarantees this
    const ids = Array.from({ length: 1000 }, () => uuidv7(1_788_616_987_100))
    expect([...ids].sort()).toEqual(ids)
  })

  it('sorts ascending across milliseconds', () => {
    const ids = [uuidv7(1_000_000), uuidv7(1_000_001), uuidv7(1_000_002)]
    expect([...ids].sort()).toEqual(ids)
  })

  it('does not go backwards when the clock does', () => {
    const first = uuidv7(1_788_616_988_000)
    const second = uuidv7(1_788_616_987_000)
    expect(second > first).toBe(true)
  })

  it('is not derived from content, so two identical events get two ids', () => {
    expect(uuidv7(1_788_616_987_000)).not.toBe(uuidv7(1_788_616_987_000))
  })

  it('draws each random byte once, across a refill of the pool', () => {
    // every fill is numbered, and each byte records its fill and its place,
    // so an id's random tail says exactly which bytes it was given
    let fills = 0
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
      array: Uint8Array,
    ) => {
      fills += 1
      for (let i = 0; i < array.length; i++) array[i] = (i * 7 + fills * 101) & 0xff
      return array
    }) as typeof crypto.getRandomValues)
    try {
      // mint until an id starts a fresh pool, so the next ones take known bytes
      let first = uuidv7(1_788_616_990_000)
      for (let guard = 0; fills === 0 && guard < 300; guard++) first = uuidv7(1_788_616_990_000)
      expect(fills).toBe(1)

      const ids = [first]
      for (let n = 1; n <= 256; n++) ids.push(uuidv7(1_788_616_990_000))
      expect(fills).toBe(2)

      const expectedTail = (fill: number, start: number) =>
        Array.from({ length: 6 }, (_, k) =>
          (((start + 10 + k) * 7 + fill * 101) & 0xff).toString(16).padStart(2, '0'),
        ).join('')
      ids.forEach((id, n) => {
        // 256 ids of 16 bytes use up one pool, and the 257th opens the next
        const fill = n < 256 ? 1 : 2
        const start = n < 256 ? n * 16 : 0
        expect(id.slice(-12)).toBe(expectedTail(fill, start))
        expect(id).toMatch(V7)
      })
      expect([...ids].sort()).toEqual(ids)
    } finally {
      spy.mockRestore()
    }
  })
})
