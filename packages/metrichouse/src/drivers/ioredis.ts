/**
 * The ioredis driver — shared, durable storage for open buckets and staged
 * records.
 *
 * Writes go straight to Redis, pipelined, with no local buffer, so every
 * instance contributes to the same bucket and a live read is globally exact.
 * A claim is a real move into a key of its own, so it survives the process
 * that took it — which is what turns the flush guarantee from best-effort into
 * at-least-once.
 *
 * ```
 *              memory                        ioredis
 * claim        read-and-hold in a Map        RENAME-equivalent into a key
 * crash        the window is gone            the window is still there
 * recover      nothing to find               puts the window back, on a cutoff
 * capabilities durable:false shared:false    durable:true shared:true
 * ```
 *
 * **Named for the client, not the database.** `ioredis(client)` rather than
 * `redis(client)`, because the two mainstream clients disagree about
 * everything at the surface — `hincrby` against `hIncrBy`, `pipeline()`
 * against `multi()` — and a driver that pretends otherwise ends up lying about
 * one of them. The name leaves `nodeRedis()` free for whoever wants it, and
 * the {@link describeDriverContract} suite is what will tell them they got it
 * right.
 */

import { type DurationInput, parseDuration } from '../time/duration.js'
import {
  type AppendOp,
  type BucketClaim,
  type BucketQuery,
  type BucketRow,
  type Cell,
  type Claim,
  type ClaimedBucket,
  type Driver,
  type GaugeOp,
  type IncrOp,
  isRecordClaim,
  type LevelOp,
  type LevelSeries,
  NOTHING_RECOVERED,
  type PendingQuery,
  type RecordClaim,
  type RecoveryReport,
  type StagedRecord,
} from './types.js'

/**
 * The slice of a Redis client this driver uses.
 *
 * Declared structurally rather than imported from `ioredis`, because the
 * package is an **optional** peer: a consumer who only ever uses
 * `metrichouse/memory` should not need it installed for their build to
 * typecheck. An `ioredis` `Redis` satisfies this shape as-is.
 */
export interface IoredisClient {
  pipeline(): IoredisPipeline
  script(subcommand: string, ...args: unknown[]): Promise<unknown>
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>
  hget(key: string, field: string): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
  hkeys(key: string): Promise<string[]>
  hdel(key: string, ...fields: string[]): Promise<number>
  llen(key: string): Promise<number>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>
  incr(key: string): Promise<number>
}

/** The chainable half of {@link IoredisClient}. */
export interface IoredisPipeline {
  hincrbyfloat(key: string, field: string, increment: string | number): unknown
  rpush(key: string, ...values: string[]): unknown
  zadd(key: string, score: string | number, member: string): unknown
  hgetall(key: string): unknown
  hget(key: string, field: string): unknown
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): unknown
  exec(): Promise<[error: Error | null, result: unknown][] | null>
}

/** A client, or a way to get one. */
export type IoredisSource = IoredisClient | (() => IoredisClient | Promise<IoredisClient>)

export interface IoredisDriverOptions {
  /**
   * Key prefix. Defaults to `mh`.
   *
   * Two houses sharing one Redis need different namespaces, and so do two
   * test runs — the suite gives each driver a random one for exactly that
   * reason.
   */
  readonly namespace?: string

  /**
   * How many commands go into one pipelined round trip. Defaults to 1000.
   *
   * A batch larger than this is split. The cap is about the reply buffer and
   * the Lua stack, not about correctness: a split batch is still one logical
   * write, and nothing reads between the halves.
   */
  readonly maxPipelineSize?: number

  /**
   * How long a claim may be in flight before {@link Driver.recover} treats it
   * as abandoned by a dead flusher. Defaults to `'5m'`.
   *
   * **Set this above your sink's timeout.** It is the one number that decides
   * whether a claim belongs to a corpse or to a process that is simply taking
   * its time, and there is no way to tell those apart from here. Too low and a
   * slow write has its rows taken back and shipped by someone else — a
   * duplicate, which the row ids survive, plus a failed `ack` on the original
   * flush, which is only noise. Too high and a genuinely crashed window waits
   * longer to ship. The default is generous for that reason.
   *
   * `0` recovers every claim on sight, including ones taken a moment ago,
   * which is useful in a test and nowhere else.
   */
  readonly recoverAfter?: DurationInput
}

/** Introspection this driver offers beyond the {@link Driver} contract. */
export interface IoredisDriver extends Driver {
  /** The exact key a bucket lives at, so you can go and look at it. */
  keyFor(metric: string, bucketTs: number): string
  /** Distinct dim keys currently live for a metric — cardinality, watched. */
  scanSeries(metric: string): Promise<string[]>
}

const DEFAULT_NAMESPACE = 'mh'
const DEFAULT_MAX_PIPELINE = 1000
/** Five minutes. Far longer than any sane sink, which is the point. */
const DEFAULT_RECOVER_AFTER = 300_000

/**
 * A gauge fold, packed into one hash field as `last|min|max|sum|count`.
 *
 * `%.17g` and not `%.14g` — Lua's default `tostring` is the latter, and a fold
 * that round-trips through it loses the bottom bits of every `sum` on every
 * observation. Seventeen significant digits is what an f64 needs to survive
 * the trip unchanged.
 */
const LUA_HELPERS = `
-- nil when the field is empty, a five-number table for a gauge fold, the
-- string 'level' for a level cell, and false for a counter's bare scalar
local function mh_parse(v)
  if v == false or v == nil then return nil end
  if string.sub(v, 1, 1) == '@' then return 'level' end
  local a,b,c,d,e = string.match(v, '^([^|]+)|([^|]+)|([^|]+)|([^|]+)|([^|]+)$')
  if a == nil then return false end
  return { tonumber(a), tonumber(b), tonumber(c), tonumber(d), tonumber(e) }
end

local function mh_pack(l, mn, mx, s, c)
  return string.format('%.17g|%.17g|%.17g|%.17g|%.17g', l, mn, mx, s, c)
end

-- a level cell wears an '@' so storage can tell it from a counter's scalar,
-- which is otherwise the same digits meaning the opposite thing on a merge
local function mh_pack_level(v)
  return '@' .. string.format('%.17g', v)
end

local function mh_is_level(v)
  return v ~= false and v ~= nil and string.sub(v, 1, 1) == '@'
end
`

/**
 * Fold observations into one bucket atomically.
 *
 * `min`, `max` and `last` are not increments, so this cannot be a pipelined
 * `HINCRBYFLOAT` the way a counter can: two writers doing read-modify-write
 * from the client would lose observations. One key per call, so the script
 * stays correct under Redis Cluster's crossslot rule.
 *
 * KEYS: bucket hash, bucket index. ARGV: bucketTs, then dimKey/value pairs.
 */
const MERGE_GAUGE = `${LUA_HELPERS}
for i = 2, #ARGV, 2 do
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  local cur = mh_parse(redis.call('HGET', KEYS[1], field))

  if cur == false then
    return redis.error_reply('MHKIND holds counter cells - observe is a gauge op')
  end
  if cur == 'level' then
    return redis.error_reply('MHKIND holds level cells - observe is a gauge op')
  end

  if cur == nil then
    redis.call('HSET', KEYS[1], field, mh_pack(v, v, v, v, 1))
  else
    redis.call('HSET', KEYS[1], field, mh_pack(
      v,
      math.min(cur[2], v),
      math.max(cur[3], v),
      cur[4] + v,
      cur[5] + 1
    ))
  end
end
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1])
return 1
`

/**
 * The level state for one series, packed as `value|writtenAt|heldThrough`.
 *
 * Its own hash per metric, never touched by a claim. That is the whole reason
 * a level can ship a row for a window nobody wrote to: the number outlives
 * the flush that shipped the last one.
 */
const LUA_LEVEL_STATE = `
local function mh_read_state(key, field)
  local raw = redis.call('HGET', key, field)
  if raw == false then return nil end
  local v, c, w, h = string.match(raw, '^([^|]+)|([^|]+)|([^|]+)|([^|]+)$')
  if v == nil then return nil end
  return { tonumber(v), tonumber(c), tonumber(w), tonumber(h) }
end

local function mh_write_state(key, field, value, carried, writtenAt, heldThrough)
  redis.call('HSET', key, field,
    string.format('%.17g|%.17g|%d|%d', value, carried, writtenAt, heldThrough))
end
`

/**
 * Put a level at a value, or move it by one, and record the same number in
 * the bucket the write landed in.
 *
 * One script rather than two round trips because the two have to agree: a
 * held value written without its bucket reports a level no window carries,
 * and a bucket written without the held value is a level that forgets itself
 * at the next flush.
 *
 * The pointer is deliberately left alone. Windows between this write and the
 * previous one are still owed a row, and only a hold may say they have had
 * one.
 *
 * KEYS: bucket hash, bucket index, level hash. ARGV: bucketTs, mode, then
 * dimKey/value pairs.
 */
const SET_LEVEL = `${LUA_HELPERS}${LUA_LEVEL_STATE}
local bucketTs = tonumber(ARGV[1])

for i = 3, #ARGV, 2 do
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  local state = mh_read_state(KEYS[3], field)

  local value = v
  if ARGV[2] == 'add' and state ~= nil then value = state[1] + v end

  local cur = redis.call('HGET', KEYS[1], field)
  if cur ~= false and not mh_is_level(cur) then
    local held = 'counter'
    if mh_parse(cur) ~= false then held = 'gauge' end
    return redis.error_reply('MHKIND holds ' .. held .. ' cells - set is a level op')
  end

  redis.call('HSET', KEYS[1], field, mh_pack_level(value))

  -- a first write is also the first thing there is to carry
  local carried = value
  local writtenAt = bucketTs
  local heldThrough = bucketTs
  if state ~= nil then
    carried = state[2]
    if state[3] > writtenAt then writtenAt = state[3] end
    heldThrough = state[4]
  end
  mh_write_state(KEYS[3], field, value, carried, writtenAt, heldThrough)
end

redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1])
return 1
`

/**
 * Carry each series' held value into one window that has none.
 *
 * Write-if-absent, so an observed value always beats a carried one: a set
 * that raced this hold into the same window keeps the number somebody
 * actually wrote.
 *
 * A series the metric asked to hold but storage has never seen is skipped.
 * There is nothing to carry, and a zero would put a line on a chart for a
 * queue that has never existed.
 *
 * KEYS: bucket hash, bucket index, level hash. ARGV: bucketTs, then
 * dimKey/value pairs.
 */
const HOLD_LEVEL = `${LUA_HELPERS}${LUA_LEVEL_STATE}
local bucketTs = tonumber(ARGV[1])
local written = 0

for i = 2, #ARGV, 2 do
  local field = ARGV[i]
  local value = tonumber(ARGV[i + 1])
  local state = mh_read_state(KEYS[3], field)

  if state ~= nil then
    if redis.call('HSETNX', KEYS[1], field, mh_pack_level(value)) == 1 then
      written = written + 1
    end
    local heldThrough = state[4]
    if bucketTs > heldThrough then heldThrough = bucketTs end
    mh_write_state(KEYS[3], field, state[1], value, state[3], heldThrough)
  end
end

if written > 0 then redis.call('ZADD', KEYS[2], ARGV[1], ARGV[1]) end
return written
`

/**
 * Move every bucket strictly below a watermark into one in-flight key.
 *
 * Atomic, so a second flusher racing this one sees an index with those buckets
 * already gone rather than a half-moved window. The claim is registered in the
 * claims ZSET even when it carries nothing, because an empty claim is still a
 * claim that has to be settled exactly once.
 *
 * KEYS: index, in-flight hash, claims. ARGV: watermark, claimId, claimedAt,
 * bucket key prefix.
 */
const CLAIM_BUCKETS = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
for i = 1, #ids do
  local bucketTs = ids[i]
  local data = redis.call('HGETALL', ARGV[4] .. bucketTs)
  local flat = {}
  for j = 1, #data, 2 do
    flat[#flat + 1] = bucketTs .. ':' .. data[j]
    flat[#flat + 1] = data[j + 1]
  end
  -- chunked: unpack() past a few thousand arguments overflows the Lua stack
  for j = 1, #flat, 1000 do
    local chunk = {}
    for m = j, math.min(j + 999, #flat) do chunk[#chunk + 1] = flat[m] end
    redis.call('HSET', KEYS[2], unpack(chunk))
  end
  redis.call('DEL', ARGV[4] .. bucketTs)
  redis.call('ZREM', KEYS[1], bucketTs)
end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
return redis.call('HGETALL', KEYS[2])
`

/**
 * Settle a claim by discarding it.
 *
 * The ZREM is the interlock: it reports whether this claim was in flight at
 * all, which is what makes a double-ack an error instead of a silent no-op.
 *
 * KEYS: claims, in-flight. ARGV: claimId.
 */
const ACK_CLAIM = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('DEL', KEYS[2])
return 1
`

/**
 * Put one in-flight bucket hash back into the live set.
 *
 * Merge, never overwrite: a write can land in a bucket while it is claimed —
 * backdated, or a straggler from another instance — and overwriting would drop
 * it silently. A counter merges by addition, a gauge by folding the two halves
 * with the *newer* one keeping `last`.
 *
 * A function rather than two copies, because {@link RELEASE_BUCKETS} and
 * {@link RECOVER_CLAIMS} both put a claim back and a merge rule written twice
 * is a merge rule that eventually disagrees with itself.
 *
 * Returns how many distinct buckets it restored.
 */
const LUA_RESTORE_BUCKETS = `${LUA_HELPERS}
local function mh_restore_buckets(inflight, prefix, idx)
  local data = redis.call('HGETALL', inflight)
  local seen = {}
  local buckets = 0

  for i = 1, #data, 2 do
    local composite = data[i]
    local held = data[i + 1]
    -- bucketTs is digits, so the first colon is always the real boundary,
    -- whatever the dim key happens to contain
    local sep = string.find(composite, ':', 1, true)
    local bucketTs = string.sub(composite, 1, sep - 1)
    local field = string.sub(composite, sep + 1)
    local key = prefix .. bucketTs

    if seen[bucketTs] == nil then
      seen[bucketTs] = true
      buckets = buckets + 1
    end

    local cur = redis.call('HGET', key, field)
    if cur == false then
      redis.call('HSET', key, field, held)
    else
      local h = mh_parse(held)
      local c = mh_parse(cur)
      if h == 'level' and c == 'level' then
        -- a level does not accumulate. Both cells are the same window read
        -- twice, and the one already live is the later of the two
        local noop = true
      elseif h == false and c == false then
        redis.call('HINCRBYFLOAT', key, field, held)
      elseif type(h) == 'table' and type(c) == 'table' then
        redis.call('HSET', key, field, mh_pack(
          c[1],
          math.min(h[2], c[2]),
          math.max(h[3], c[3]),
          h[4] + c[4],
          h[5] + c[5]
        ))
      else
        error(redis.error_reply('MHKIND cannot merge cells of two different kinds'))
      end
    end

    -- dropped from the claim as it lands. The kind clash above aborts the
    -- script, and Redis does not roll a script back, so a re-run has to finish
    -- the job rather than add the cells it already restored a second time.
    redis.call('HDEL', inflight, composite)
    redis.call('ZADD', idx, bucketTs, bucketTs)
  end

  return buckets
end
`

/**
 * Put one in-flight record list back at the **front** of the queue.
 *
 * They are older than anything appended while they were in flight, and a claim
 * ships oldest first, so returning them to the back would ship out of order.
 *
 * `LPUSH a b c` leaves `c b a`, so each chunk goes in reversed, and the chunks
 * themselves run back to front — which is what lands the whole run in its
 * original order.
 *
 * Returns how many records it restored.
 */
const LUA_RESTORE_RECORDS = `
local function mh_restore_records(inflight, records)
  local held = redis.call('LRANGE', inflight, 0, -1)
  local i = #held
  while i >= 1 do
    local chunk = {}
    local stop = math.max(1, i - 999)
    for j = i, stop, -1 do chunk[#chunk + 1] = held[j] end
    redis.call('LPUSH', records, unpack(chunk))
    i = stop - 1
  end
  return #held
end
`

/**
 * Settle a claim by putting the data back.
 *
 * KEYS: claims, in-flight hash, index. ARGV: claimId, bucket key prefix.
 */
const RELEASE_BUCKETS = `${LUA_RESTORE_BUCKETS}
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return 0 end
mh_restore_buckets(KEYS[2], ARGV[2], KEYS[3])
redis.call('DEL', KEYS[2])
return 1
`

/**
 * Move staged records into a claim, oldest first.
 *
 * No watermark: a record is complete the instant it is appended. `limit` is
 * what bounds a backlog larger than the sink will take, and `-1` means all of
 * it.
 *
 * KEYS: records, in-flight list, claims. ARGV: limit, claimId, claimedAt.
 */
const CLAIM_RECORDS = `
local n = tonumber(ARGV[1])
local len = redis.call('LLEN', KEYS[1])
if n < 0 or n > len then n = len end

local taken = {}
if n > 0 then
  taken = redis.call('LRANGE', KEYS[1], 0, n - 1)
  redis.call('LTRIM', KEYS[1], n, -1)
  for i = 1, #taken, 1000 do
    local chunk = {}
    for j = i, math.min(i + 999, #taken) do chunk[#chunk + 1] = taken[j] end
    redis.call('RPUSH', KEYS[2], unpack(chunk))
  end
end

redis.call('ZADD', KEYS[3], ARGV[3], ARGV[2])
return taken
`

/**
 * Settle a record claim by putting the records back.
 *
 * KEYS: records, in-flight list, claims. ARGV: claimId.
 */
const RELEASE_RECORDS = `${LUA_RESTORE_RECORDS}
if redis.call('ZREM', KEYS[3], ARGV[1]) == 0 then return 0 end
mh_restore_records(KEYS[2], KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`

/**
 * Put every claim older than a cutoff back into the live set.
 *
 * The other half of the at-least-once guarantee, and the half `claim` cannot
 * provide. A claim moves data out of the live set; a flusher that dies before
 * settling one leaves a batch that no later `claim` can reach, because `claim`
 * reads the index and the abandoned buckets were taken out of it. This walks
 * the claims registry instead, which is the only place that still names them.
 *
 * **The cutoff is a guess about a dead process, so it errs long.** There is no
 * way to ask a claim whether its owner is still writing, and taking one back
 * from an owner that is merely slow ships those rows twice and fails that
 * owner's `ack`. Waiting longer costs a later delivery, which is the cheaper
 * mistake by a wide margin.
 *
 * KEYS: claims, index, records. ARGV: cutoff, in-flight prefix, bucket prefix.
 */
const RECOVER_CLAIMS = `${LUA_RESTORE_BUCKETS}${LUA_RESTORE_RECORDS}
local abandoned = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'WITHSCORES')
local claims = 0
local buckets = 0
local records = 0
local oldest = 0

for i = 1, #abandoned, 2 do
  local id = abandoned[i]
  local inflight = ARGV[2] .. id

  -- a claim id says nothing about which storage model it holds, and it does
  -- not have to: a bucket claim is a hash and a record claim is a list. 'none'
  -- is an empty claim, which moved nothing and only has a registration to drop
  local kind = redis.call('TYPE', inflight)['ok']
  if kind == 'hash' then
    buckets = buckets + mh_restore_buckets(inflight, ARGV[3], KEYS[2])
  elseif kind == 'list' then
    records = records + mh_restore_records(inflight, KEYS[3])
  end

  -- restored first, deregistered second, and that order is safe only because
  -- a script is one atomic step: no client can see a claim that is both back
  -- in the live set and still registered. A script that aborts partway leaves
  -- a claim the next pass finishes, rather than one nobody is named on.
  redis.call('DEL', inflight)
  redis.call('ZREM', KEYS[1], id)

  -- ascending by score, so the first one through is the longest stranded
  if claims == 0 then oldest = tonumber(abandoned[i + 1]) end
  claims = claims + 1
end

return { claims, buckets, records, oldest }
`

/**
 * Marks an encoded `Date` inside a record's fields.
 *
 * `fields` is opaque to the driver, but it is not opaque to `JSON`: a `ts()`
 * field reaches storage as a real `Date`, and plain `JSON.stringify` would
 * hand it back as a string. The metric would then put that string in the row
 * where a `Date` belongs — a difference from the memory driver that nothing
 * would report, so the contract suite pins it.
 */
const DATE_TAG = '__mh_date'

function encodeRecord(op: AppendOp): string {
  return JSON.stringify({ id: op.id, ts: op.ts, fields: op.fields }, function (key, value) {
    // `value` has already been through Date.prototype.toJSON by the time a
    // replacer sees it — the original is only reachable through `this`
    const raw = (this as Record<string, unknown>)[key]
    return raw instanceof Date ? { [DATE_TAG]: raw.getTime() } : value
  })
}

function decodeRecord(json: string): StagedRecord {
  return JSON.parse(json, (_key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const tagged = value as Record<string, unknown>
    const ms = tagged[DATE_TAG]
    if (typeof ms === 'number' && Object.keys(tagged).length === 1) return new Date(ms)
    return value
  }) as StagedRecord
}

/** A packed gauge fold, a level's held value, or a counter's scalar. */
function decodeCell(raw: string): Cell {
  if (raw.startsWith('@')) return { level: Number(raw.slice(1)) }

  const parts = raw.split('|')
  if (parts.length !== 5) return Number(raw)
  return {
    last: Number(parts[0]),
    min: Number(parts[1]),
    max: Number(parts[2]),
    sum: Number(parts[3]),
    count: Number(parts[4]),
  }
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT')
}

/**
 * Turn a Redis-side type complaint into the error the memory driver raises.
 *
 * Two kinds reach here. A gauge script detects the clash itself and says
 * `MHKIND`; a counter's `HINCRBYFLOAT` just fails to parse the packed fold and
 * says "hash value is not a float", which is true and unhelpful.
 */
function typedError(error: unknown, metric: string): Error {
  const message = error instanceof Error ? error.message : String(error)

  const kind = message.indexOf('MHKIND')
  if (kind !== -1) {
    return new Error(`ioredis driver: ${metric} ${message.slice(kind + 'MHKIND'.length).trim()}`)
  }
  if (message.includes('not a float') || message.includes('not an integer')) {
    return new Error(
      `ioredis driver: ${metric} holds gauge or level cells — increment is a counter op`,
    )
  }
  return error instanceof Error ? error : new Error(message)
}

export function ioredis(source: IoredisSource, options: IoredisDriverOptions = {}): IoredisDriver {
  const ns = options.namespace ?? DEFAULT_NAMESPACE
  const maxPipeline = Math.max(1, options.maxPipelineSize ?? DEFAULT_MAX_PIPELINE)
  const recoverAfterMs = parseDuration(options.recoverAfter ?? DEFAULT_RECOVER_AFTER)

  const key = {
    bucket: (metric: string, bucketTs: number | string) => `${ns}:b:${metric}:${bucketTs}`,
    bucketPrefix: (metric: string) => `${ns}:b:${metric}:`,
    idx: (metric: string) => `${ns}:idx:${metric}`,
    levels: (metric: string) => `${ns}:lvl:${metric}`,
    records: (metric: string) => `${ns}:e:${metric}`,
    inflight: (claimId: string) => `${ns}:inflight:${claimId}`,
    claims: (metric: string) => `${ns}:claims:${metric}`,
    seq: `${ns}:seq`,
  }

  /**
   * Resolved once and reused.
   *
   * A factory is called on first write rather than at module scope, so
   * importing a schema file never opens a socket — which is what makes the
   * same module safe to load in a build step or a test that never writes.
   */
  let connection: Promise<IoredisClient> | undefined
  function connect(): Promise<IoredisClient> {
    if (!connection) {
      connection = Promise.resolve(typeof source === 'function' ? source() : source)
    }
    return connection
  }

  /** Script source -> SHA1, filled by the first call that needs it. */
  const shas = new Map<string, string>()

  async function shaFor(client: IoredisClient, script: string): Promise<string> {
    const cached = shas.get(script)
    if (cached !== undefined) return cached

    const sha = String(await client.script('LOAD', script))
    shas.set(script, sha)
    return sha
  }

  function unwrap(
    results: [error: Error | null, result: unknown][] | null,
    what: string,
  ): unknown[] {
    if (results === null) throw new Error(`ioredis driver: ${what} pipeline was discarded`)

    return results.map(([error, value]) => {
      if (error) throw error
      return value
    })
  }

  interface ScriptCall {
    readonly script: string
    readonly keys: readonly string[]
    readonly args: readonly (string | number)[]
  }

  /**
   * Run scripts in one round trip, reloading them if Redis has forgotten.
   *
   * A restart or a `SCRIPT FLUSH` invalidates every cached SHA at once, so the
   * recovery is to drop the whole cache and replay — not to unpick which of
   * the calls in this batch failed.
   */
  async function runScripts(calls: readonly ScriptCall[], what: string): Promise<unknown[]> {
    if (calls.length === 0) return []
    const client = await connect()

    const attempt = async (): Promise<[error: Error | null, result: unknown][] | null> => {
      const resolved = await Promise.all(calls.map((call) => shaFor(client, call.script)))
      const pipeline = client.pipeline()
      calls.forEach((call, index) => {
        pipeline.evalsha(resolved[index] as string, call.keys.length, ...call.keys, ...call.args)
      })
      return pipeline.exec()
    }

    let results = await attempt()
    if (results?.some(([error]) => isNoScript(error))) {
      shas.clear()
      results = await attempt()
    }
    return unwrap(results, what)
  }

  /** Queue commands, split into round trips no larger than `maxPipelineSize`. */
  async function runCommands(
    commands: readonly ((pipeline: IoredisPipeline) => void)[],
    what: string,
  ): Promise<unknown[]> {
    if (commands.length === 0) return []
    const client = await connect()

    const out: unknown[] = []
    for (let start = 0; start < commands.length; start += maxPipeline) {
      const pipeline = client.pipeline()
      for (const queue of commands.slice(start, start + maxPipeline)) queue(pipeline)
      out.push(...unwrap(await pipeline.exec(), what))
    }
    return out
  }

  async function nextClaimId(metric: string): Promise<string> {
    const client = await connect()
    return `${metric}#${await client.incr(key.seq)}`
  }

  /** The flat `HGETALL` of an in-flight key, back into buckets and series. */
  function unflatten(flat: readonly string[]): ClaimedBucket[] {
    const byBucket = new Map<number, Map<string, Cell>>()

    for (let i = 0; i < flat.length; i += 2) {
      const composite = flat[i] as string
      const separator = composite.indexOf(':')
      const bucketTs = Number(composite.slice(0, separator))
      const dimKey = composite.slice(separator + 1)

      let values = byBucket.get(bucketTs)
      if (!values) {
        values = new Map()
        byBucket.set(bucketTs, values)
      }
      values.set(dimKey, decodeCell(flat[i + 1] as string))
    }

    return [...byBucket.keys()]
      .sort((a, b) => a - b)
      .map((bucketTs) => ({ bucketTs, values: byBucket.get(bucketTs) as Map<string, Cell> }))
  }

  return {
    capabilities: {
      durable: true,
      shared: true,
      atomicMerge: true,
    },

    keyFor(metric: string, bucketTs: number): string {
      return key.bucket(metric, bucketTs)
    },

    async scanSeries(metric: string): Promise<string[]> {
      const client = await connect()
      const buckets = await client.zrangebyscore(key.idx(metric), '-inf', '+inf')
      // through the index rather than SCAN: it is exact, it costs one call per
      // live bucket instead of a keyspace sweep, and it already excludes
      // anything a claim has taken
      const perBucket = await Promise.all(
        buckets.map((bucketTs) => client.hkeys(key.bucket(metric, bucketTs))),
      )
      return [...new Set(perBucket.flat())].sort()
    },

    async increment(ops: readonly IncrOp[]): Promise<void> {
      if (ops.length === 0) return

      const commands: ((pipeline: IoredisPipeline) => void)[] = []
      const indexed = new Set<string>()

      for (const op of ops) {
        // the index first: a bucket Redis knows about but has not counted into
        // yet is harmless, one Redis has counted into but does not know about
        // is a bucket no claim will ever find
        const bucketKey = key.bucket(op.metric, op.bucketTs)
        if (!indexed.has(bucketKey)) {
          indexed.add(bucketKey)
          commands.push((pipeline) =>
            pipeline.zadd(key.idx(op.metric), op.bucketTs, String(op.bucketTs)),
          )
        }
        commands.push((pipeline) => pipeline.hincrbyfloat(bucketKey, op.dimKey, op.delta))
      }

      try {
        await runCommands(commands, 'increment')
      } catch (error) {
        throw typedError(error, ops[0]?.metric ?? 'unknown')
      }
    },

    async observe(ops: readonly GaugeOp[]): Promise<void> {
      if (ops.length === 0) return

      // grouped by bucket, so each script touches exactly one hash: the fold
      // stays atomic, and one call carries a whole batch for that bucket
      interface Group {
        readonly metric: string
        readonly bucketTs: number
        readonly args: (string | number)[]
      }
      const groups = new Map<string, Group>()

      for (const op of ops) {
        const bucketKey = key.bucket(op.metric, op.bucketTs)
        let group = groups.get(bucketKey)
        if (!group) {
          group = { metric: op.metric, bucketTs: op.bucketTs, args: [op.bucketTs] }
          groups.set(bucketKey, group)
        }
        group.args.push(op.dimKey, op.value)
      }

      try {
        await runScripts(
          [...groups.values()].map((group) => ({
            script: MERGE_GAUGE,
            keys: [key.bucket(group.metric, group.bucketTs), key.idx(group.metric)],
            args: group.args,
          })),
          'observe',
        )
      } catch (error) {
        throw typedError(error, ops[0]?.metric ?? 'unknown')
      }
    },

    async setLevel(ops: readonly LevelOp[]): Promise<void> {
      if (ops.length === 0) return

      // grouped by bucket for the same reason `observe` is: one script, one
      // hash, so the held value and the cell it names move together
      interface Group {
        readonly metric: string
        readonly bucketTs: number
        readonly mode: LevelOp['mode']
        readonly args: (string | number)[]
      }
      const groups = new Map<string, Group>()

      for (const op of ops) {
        const groupKey = `${op.mode}\u0000${key.bucket(op.metric, op.bucketTs)}`
        let group = groups.get(groupKey)
        if (!group) {
          group = {
            metric: op.metric,
            bucketTs: op.bucketTs,
            mode: op.mode,
            args: op.mode === 'hold' ? [op.bucketTs] : [op.bucketTs, op.mode],
          }
          groups.set(groupKey, group)
        }
        group.args.push(op.dimKey, op.value)
      }

      try {
        await runScripts(
          [...groups.values()].map((group) => ({
            script: group.mode === 'hold' ? HOLD_LEVEL : SET_LEVEL,
            keys: [
              key.bucket(group.metric, group.bucketTs),
              key.idx(group.metric),
              key.levels(group.metric),
            ],
            args: group.args,
          })),
          'setLevel',
        )
      } catch (error) {
        throw typedError(error, ops[0]?.metric ?? 'unknown')
      }
    },

    async readLevels(metric: string): Promise<LevelSeries[]> {
      const client = await connect()
      const flat = await client.hgetall(key.levels(metric))

      const series: LevelSeries[] = []
      for (const [dimKey, packed] of Object.entries(flat)) {
        const parts = packed.split('|')
        if (parts.length !== 4) continue
        series.push({
          dimKey,
          value: Number(parts[0]),
          carried: Number(parts[1]),
          writtenAt: Number(parts[2]),
          heldThrough: Number(parts[3]),
        })
      }

      return series.sort((a, b) => (a.dimKey < b.dimKey ? -1 : 1))
    },

    async dropLevels(metric: string, dimKeys: readonly string[]): Promise<void> {
      if (dimKeys.length === 0) return
      const client = await connect()
      await client.hdel(key.levels(metric), ...dimKeys)
    },

    async append(ops: readonly AppendOp[]): Promise<void> {
      if (ops.length === 0) return

      const byMetric = new Map<string, string[]>()
      for (const op of ops) {
        const encoded = byMetric.get(op.metric)
        if (encoded) encoded.push(encodeRecord(op))
        else byMetric.set(op.metric, [encodeRecord(op)])
      }

      await runCommands(
        [...byMetric].map(
          ([metric, encoded]) =>
            (pipeline: IoredisPipeline) =>
              pipeline.rpush(key.records(metric), ...encoded),
        ),
        'append',
      )
    },

    async readBuckets(query: BucketQuery): Promise<BucketRow[]> {
      const client = await connect()

      const buckets = await client.zrangebyscore(
        key.idx(query.metric),
        query.from ?? '-inf',
        // half-open: `(` is Redis for an exclusive bound
        query.to === undefined ? '+inf' : `(${query.to}`,
      )
      if (buckets.length === 0) return []

      const rows: BucketRow[] = []

      if (query.dimKey !== undefined) {
        // one field, not the whole hash — a metric with a million series
        // should not come over the wire to answer a question about one of them
        const dimKey = query.dimKey
        const values = await runCommands(
          buckets.map(
            (bucketTs) => (pipeline: IoredisPipeline) =>
              pipeline.hget(key.bucket(query.metric, bucketTs), dimKey),
          ),
          'readBuckets',
        )
        buckets.forEach((bucketTs, index) => {
          const raw = values[index]
          if (typeof raw !== 'string') return
          rows.push({ bucketTs: Number(bucketTs), dimKey, value: decodeCell(raw) })
        })
      } else {
        const hashes = await runCommands(
          buckets.map(
            (bucketTs) => (pipeline: IoredisPipeline) =>
              pipeline.hgetall(key.bucket(query.metric, bucketTs)),
          ),
          'readBuckets',
        )
        buckets.forEach((bucketTs, index) => {
          const hash = (hashes[index] ?? {}) as Record<string, string>
          for (const [dimKey, raw] of Object.entries(hash)) {
            rows.push({ bucketTs: Number(bucketTs), dimKey, value: decodeCell(raw) })
          }
        })
      }

      // deterministic, so callers and tests never depend on hash field order
      rows.sort((a, b) => a.bucketTs - b.bucketTs || (a.dimKey < b.dimKey ? -1 : 1))
      return rows
    },

    async readPending(query: PendingQuery): Promise<StagedRecord[]> {
      if (query.limit !== undefined && query.limit <= 0) return []
      const client = await connect()
      const listKey = key.records(query.metric)

      // no ts bound: the limit is the range, and one LRANGE answers it
      if (query.from === undefined && query.to === undefined) {
        const stop = query.limit === undefined ? -1 : query.limit - 1
        return (await client.lrange(listKey, 0, stop)).map(decodeRecord)
      }

      // bounded: paged rather than one LRANGE of everything, so a backlog the
      // query will mostly reject never crosses the wire whole
      const matched: StagedRecord[] = []
      const page = maxPipeline

      for (let start = 0; ; start += page) {
        const raw = await client.lrange(listKey, start, start + page - 1)
        if (raw.length === 0) break

        for (const encoded of raw) {
          const record = decodeRecord(encoded)
          if (query.from !== undefined && record.ts < query.from) continue
          if (query.to !== undefined && record.ts >= query.to) continue
          matched.push(record)
          if (query.limit !== undefined && matched.length >= query.limit) return matched
        }
        if (raw.length < page) break
      }
      return matched
    },

    async countPending(metric: string): Promise<number> {
      const client = await connect()
      // LLEN, not an LRANGE the caller counts — the whole reason this is a
      // method of its own
      return client.llen(key.records(metric))
    },

    async claim(metric: string, upToBucketTs: number): Promise<BucketClaim> {
      const id = await nextClaimId(metric)
      // one instant, used twice: the score in the claims ZSET is what will
      // decide whether this claim is stale, and a claim that disagrees with
      // the registry about its own age is a claim recovery cannot reason about
      const claimedAt = Date.now()

      const [flat] = await runScripts(
        [
          {
            script: CLAIM_BUCKETS,
            keys: [key.idx(metric), key.inflight(id), key.claims(metric)],
            args: [upToBucketTs, id, claimedAt, key.bucketPrefix(metric)],
          },
        ],
        'claim',
      )

      return {
        kind: 'buckets',
        id,
        metric,
        claimedAt,
        buckets: unflatten((flat ?? []) as string[]),
      }
    },

    async claimRecords(metric: string, limit?: number): Promise<RecordClaim> {
      const id = await nextClaimId(metric)
      const claimedAt = Date.now()

      const [taken] = await runScripts(
        [
          {
            script: CLAIM_RECORDS,
            keys: [key.records(metric), key.inflight(id), key.claims(metric)],
            args: [limit === undefined ? -1 : Math.max(0, limit), id, claimedAt],
          },
        ],
        'claimRecords',
      )

      return {
        kind: 'records',
        id,
        metric,
        claimedAt,
        records: ((taken ?? []) as string[]).map(decodeRecord),
      }
    },

    async ack(claim: Claim): Promise<void> {
      const [settled] = await runScripts(
        [
          {
            script: ACK_CLAIM,
            keys: [key.claims(claim.metric), key.inflight(claim.id)],
            args: [claim.id],
          },
        ],
        'ack',
      )

      if (settled === 0) {
        throw new Error(`ioredis driver: claim ${claim.id} is not in flight — already settled?`)
      }
    },

    async release(claim: Claim): Promise<void> {
      const call: ScriptCall = isRecordClaim(claim)
        ? {
            script: RELEASE_RECORDS,
            keys: [key.records(claim.metric), key.inflight(claim.id), key.claims(claim.metric)],
            args: [claim.id],
          }
        : {
            script: RELEASE_BUCKETS,
            keys: [key.claims(claim.metric), key.inflight(claim.id), key.idx(claim.metric)],
            args: [claim.id, key.bucketPrefix(claim.metric)],
          }

      let settled: unknown
      try {
        const results = await runScripts([call], 'release')
        settled = results[0]
      } catch (error) {
        throw typedError(error, claim.metric)
      }

      if (settled === 0) {
        throw new Error(`ioredis driver: claim ${claim.id} is not in flight — already settled?`)
      }
    },

    async recover(metric: string): Promise<RecoveryReport> {
      // one instant for the whole pass, and the same clock `claim` stamped the
      // registry with, so "older than the cutoff" is a comparison between two
      // readings of one clock rather than between two machines' ideas of now
      const cutoff = Date.now() - recoverAfterMs

      let raw: unknown
      try {
        const results = await runScripts(
          [
            {
              script: RECOVER_CLAIMS,
              keys: [key.claims(metric), key.idx(metric), key.records(metric)],
              // `inflight('')` rather than a literal, so the prefix cannot
              // drift from the key the claim was actually written to
              args: [cutoff, key.inflight(''), key.bucketPrefix(metric)],
            },
          ],
          'recover',
        )
        raw = results[0]
      } catch (error) {
        throw typedError(error, metric)
      }

      const [claims = 0, buckets = 0, records = 0, oldest = 0] = (raw ?? []) as number[]
      if (claims === 0) return NOTHING_RECOVERED

      return { claims, buckets, records, ...(oldest > 0 && { oldestClaimedAt: oldest }) }
    },
  }
}
