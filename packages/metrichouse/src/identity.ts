/**
 * Row identity.
 *
 * Every row carries a stable `id` so an at-least-once resend is recognisable.
 * Aggregate rows derive theirs from content — metric name, bucket, dims — so a
 * re-sent bucket produces a byte-identical id without any stored state.
 *
 * MetricHouse guarantees the *same id*; whether your store collapses the two
 * rows is your `write()` and your table.
 *
 * Spec: initialPlan/14-identity.md
 */

import { dimOrder } from './schema/dims.js'
import type { Shape } from './schema/types.js'

/** A content hash over an ordered list of parts. */
export type Hasher = (parts: string[]) => string

/**
 * Murmur3's 32-bit finalizer. Strong avalanche — a one-bit input change
 * flips about half the output bits, which is what keeps adjacent bucket
 * timestamps from producing adjacent ids.
 */
function fmix32(value: number): number {
  let h = value
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

function toHex(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/**
 * The default hasher: 128 bits, rendered as 32 lowercase hex characters.
 *
 * Four independent 32-bit lanes are advanced in a single pass, then finalized
 * separately. Non-cryptographic and fast — these ids are for dedupe, not
 * secrecy.
 *
 * **Why 128 and not the 64 bits the spec first specified.** `metrichouse cost`
 * projects 5.4M rows per 30-second flush for a high-cardinality metric, which
 * is ~15B rows/day. At 64 bits the birthday bound makes collisions a daily
 * event, and a collision here silently merges two unrelated series into one
 * row. 16 extra bytes per row buys that away permanently.
 *
 * Each part is length-prefixed, so the boundaries between parts are real:
 * `['a', 'bc']` and `['ab', 'c']` hash differently, and a metric name
 * containing a separator cannot impersonate a dim value.
 */
export function hash(parts: string[]): string {
  let a = 0x9e3779b1
  let b = 0x85ebca77
  let c = 0xc2b2ae3d
  let d = 0x27d4eb2f

  const feed = (code: number): void => {
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ (code + 0x9e3779b9), 0x85ebca6b)
    c = Math.imul(c ^ (code + 0x7f4a7c15), 0xc2b2ae35)
    d = Math.imul(d ^ (code + 0x165667b1), 0x27d4eb2f)
  }

  for (const part of parts) {
    // length first: makes the encoding prefix-free, so part boundaries survive
    feed(part.length)
    for (let i = 0; i < part.length; i++) {
      feed(part.charCodeAt(i))
    }
  }

  return toHex(fmix32(a)) + toHex(fmix32(b)) + toHex(fmix32(c)) + toHex(fmix32(d))
}

let activeHasher: Hasher = hash

/**
 * Replace the hasher. Returns the previous one, so a caller — a test, usually
 * — can restore it.
 *
 * Changing this changes every id the process produces. Ids already in your
 * database were written by the old hasher and will not converge with new ones,
 * so this is a migration, not a setting.
 */
export function setHasher(hasher: Hasher): Hasher {
  const previous = activeHasher
  activeHasher = hasher
  return previous
}

/** The hasher currently in effect. */
export function getHasher(): Hasher {
  return activeHasher
}

/**
 * The deterministic id for one aggregate row.
 *
 * Derived from content, never from the flush: the same bucket shipped twice
 * yields the same id, which is what makes an at-least-once resend harmless.
 * `dimKey` is the already-encoded series key from `encodeDimKey`, so dim
 * values are in declaration order and escaped.
 */
export function rowId(metricName: string, bucketTs: number, dimKey: string): string {
  return activeHasher([metricName, String(bucketTs), dimKey])
}

/**
 * The tuple that identifies an aggregate row: the bucket, then every dim in
 * declaration order.
 *
 * This is what your destination should key on if you want a resend to
 * collapse rather than duplicate.
 */
export function naturalKey(dims: Shape): string[] {
  return ['bucket_ts', ...dimOrder(dims)]
}

/**
 * Random bytes, from the platform.
 *
 * `globalThis.crypto` is present on every runtime this library targets — Node
 * 20+, Bun, Deno, Workers, and the edge runtimes. The fallback is not a
 * quality choice, it is a "some sandbox removed it" choice, and the monotonic
 * counter below is what actually carries uniqueness within a process either
 * way.
 */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const source = globalThis.crypto
  if (source?.getRandomValues) {
    source.getRandomValues(bytes)
    return bytes
  }
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** Last millisecond an id was minted in, and how many were minted in it. */
let lastMs = -1
let sequence = 0

/** 12 bits of `rand_a` — the counter saturates here, not silently wraps. */
const MAX_SEQUENCE = 0xfff

/**
 * A UUIDv7 for one staged record.
 *
 * Unlike {@link rowId}, this is **not** derived from content. Two identical
 * events are two events — that is the whole reason an event exists rather than
 * a counter — so identity has to come from the act of recording rather than
 * from what was recorded. Minting it at `record()` (not at flush) is what
 * makes a released batch keep its ids and a retried write recognisable.
 *
 * v7 layout: 48 bits of epoch milliseconds, then a 12-bit counter in `rand_a`,
 * then 62 random bits. The counter is the monotonic variant from the RFC: ids
 * minted in the same millisecond stay strictly ordered, and cannot collide
 * within a process however the random bits land. On the 4097th id inside one
 * millisecond the timestamp borrows from the next — which keeps ordering, at
 * the cost of an id being at most a millisecond ahead of the clock.
 */
export function uuidv7(nowMs: number): string {
  let ms = Math.floor(nowMs)

  if (ms > lastMs) {
    lastMs = ms
    sequence = 0
  } else {
    // same millisecond, or a clock that went backwards — either way, keep
    // minting forward from where we were rather than re-using a sequence
    ms = lastMs
    sequence += 1
    if (sequence > MAX_SEQUENCE) {
      lastMs += 1
      ms = lastMs
      sequence = 0
    }
  }

  const bytes = randomBytes(16)

  // 48-bit big-endian timestamp. Split at 2^32 because a bitwise shift in JS
  // truncates to 32 bits and would silently drop the high two bytes.
  const high = Math.floor(ms / 0x1_0000_0000)
  const low = ms >>> 0
  bytes[0] = (high >>> 8) & 0xff
  bytes[1] = high & 0xff
  bytes[2] = (low >>> 24) & 0xff
  bytes[3] = (low >>> 16) & 0xff
  bytes[4] = (low >>> 8) & 0xff
  bytes[5] = low & 0xff

  // version 7 in the top nibble of byte 6, sequence in the remaining 12 bits
  bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f)
  bytes[7] = sequence & 0xff

  // variant 10xx in the top bits of byte 8; bytes 9-15 stay random
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f)

  let out = ''
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] as number]
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-'
  }
  return out
}
