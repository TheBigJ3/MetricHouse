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

import { uuidv7 } from '../identity.js'
import { isDate } from '../schema/types.js'
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
  /**
   * Close the connection. Optional in this shape, because only
   * {@link IoredisDriver.close} uses it, and only on a client the driver
   * created itself.
   */
  quit?(): Promise<unknown>
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
   * reason. No colon and no whitespace, or the constructor throws.
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
  /**
   * Close the connection this driver opened.
   *
   * Only a client the driver created, from a factory, is closed: that one is
   * unreachable from outside, so a script would otherwise never exit. A client
   * passed in directly belongs to the caller, who closes it with `quit()` when
   * they are done with it, and this leaves it alone. Call it after
   * `house.stop()`, never before: the final flush needs the connection.
   */
  close(): Promise<void>
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

-- '%.17g', the same seventeen digits the folds use, so a counter keeps every
-- bit of a double. HINCRBYFLOAT would round to seventeen decimal places
-- instead, which turns 7.77e-9 added three times into a different number than
-- the memory driver holds, and 1e-310 into 0
local function mh_num(x)
  return string.format('%.17g', x)
end

-- false for NaN and both infinities. A stored number past the largest double
-- would come back as the text 'inf', which JavaScript reads as NaN
local function mh_finite(x)
  return x == x and x ~= math.huge and x ~= -math.huge
end

-- the window a write aimed at bucketTs actually lands in. Every window below
-- the watermark has been claimed already, so a write for one of them goes to
-- the watermark instead, the oldest window that has not shipped
local function mh_landing(wmKey, bucketTs)
  local wm = redis.call('GET', wmKey)
  if wm ~= false and tonumber(bucketTs) < tonumber(wm) then return wm end
  return bucketTs
end

local MH_RANGE = 'MHRANGE would pass the largest number a metric can store, so the write was refused'
`

/**
 * Apply a write script at most once, however many times it reaches Redis.
 *
 * ioredis resends a command that got no reply before a reconnect. If that
 * command had already run, the resend runs it again, and a counter counts the
 * same increment twice. So every write carries its writer's id and a sequence
 * number, the last key and the last argument, and the script records the
 * number beside the data it writes. A number already recorded means the write
 * already happened, and the script returns without doing it again.
 *
 * The record stays small: each call also sends the lowest sequence number the
 * writer is still waiting on, the second to last argument, and everything below
 * it is removed, because nothing below it can be resent. The whole record
 * expires a day after its writer's last write.
 *
 * `MH_N` is the index of the last argument that belongs to the script itself.
 */
const LUA_ONCE = `
local MH_N = #ARGV - 2

local function mh_seen()
  return redis.call('ZSCORE', KEYS[#KEYS], ARGV[#ARGV]) ~= false
end

local function mh_mark()
  local w = KEYS[#KEYS]
  redis.call('ZREMRANGEBYSCORE', w, '-inf', '(' .. ARGV[#ARGV - 1])
  redis.call('ZADD', w, ARGV[#ARGV], ARGV[#ARGV])
  redis.call('EXPIRE', w, 86400)
end
`

/**
 * Redis's own clock, in milliseconds.
 *
 * Claims are stamped and aged by this rather than by the clock of whichever
 * process claims or recovers, so two hosts whose clocks disagree still agree
 * on how old a claim is. Asking for the time is not deterministic, which a
 * script that also writes may only do under effects replication: the default
 * from Redis 5, and switched on here for anything older.
 */
const LUA_NOW = `
if redis.replicate_commands then redis.replicate_commands() end

local function mh_now()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
`

/**
 * Add counter increments to one bucket atomically.
 *
 * A script rather than a pipeline of `HINCRBYFLOAT`, for three reasons: the
 * late write check has to read the watermark and write in one step, the sum
 * is kept to seventeen significant digits the way the memory driver keeps it,
 * and an overflow is refused instead of stored.
 *
 * Two passes: every sum is worked out and checked first, then written. Redis
 * does not roll a script back, so a refusal halfway through would otherwise
 * leave half a batch applied.
 *
 * KEYS: bucket index, watermark. ARGV: bucket key prefix, bucketTs, then
 * dimKey/delta pairs.
 */
const INCREMENT = `${LUA_HELPERS}${LUA_ONCE}
if mh_seen() then return 0 end
local target = mh_landing(KEYS[2], ARGV[2])
local key = ARGV[1] .. target
local totals = {}
local order = {}

for i = 3, MH_N, 2 do
  local field = ARGV[i]
  local total = totals[field]
  if total == nil then
    local cur = redis.call('HGET', key, field)
    local parsed = mh_parse(cur)
    if parsed == 'level' then
      return redis.error_reply('MHKIND holds level cells - increment is a counter op')
    end
    if type(parsed) == 'table' then
      return redis.error_reply('MHKIND holds gauge cells - increment is a counter op')
    end
    total = 0
    if cur ~= false then total = tonumber(cur) end
    order[#order + 1] = field
  end
  total = total + tonumber(ARGV[i + 1])
  if not mh_finite(total) then return redis.error_reply(MH_RANGE) end
  totals[field] = total
end

for _, field in ipairs(order) do
  redis.call('HSET', key, field, mh_num(totals[field]))
end
redis.call('ZADD', KEYS[1], target, target)
mh_mark()
return 1
`

/**
 * Fold observations into one bucket atomically.
 *
 * `min`, `max` and `last` are not increments, so this cannot be a pipelined
 * `HINCRBYFLOAT` the way a counter once was: two writers doing read-modify-write
 * from the client would lose observations. Checked in full before anything
 * is written, as {@link INCREMENT} is.
 *
 * KEYS: bucket index, watermark. ARGV: bucket key prefix, bucketTs, then
 * dimKey/value pairs.
 */
const MERGE_GAUGE = `${LUA_HELPERS}${LUA_ONCE}
if mh_seen() then return 0 end
local target = mh_landing(KEYS[2], ARGV[2])
local key = ARGV[1] .. target
local folds = {}
local order = {}

for i = 3, MH_N, 2 do
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  local cur = folds[field]

  if cur == nil then
    local parsed = mh_parse(redis.call('HGET', key, field))
    if parsed == false then
      return redis.error_reply('MHKIND holds counter cells - observe is a gauge op')
    end
    if parsed == 'level' then
      return redis.error_reply('MHKIND holds level cells - observe is a gauge op')
    end
    cur = parsed
    order[#order + 1] = field
  end

  if cur == nil then
    cur = { v, v, v, v, 1 }
  else
    cur = { v, math.min(cur[2], v), math.max(cur[3], v), cur[4] + v, cur[5] + 1 }
  end
  if not mh_finite(cur[4]) then return redis.error_reply(MH_RANGE) end
  folds[field] = cur
end

for _, field in ipairs(order) do
  local f = folds[field]
  redis.call('HSET', key, field, mh_pack(f[1], f[2], f[3], f[4], f[5]))
end
redis.call('ZADD', KEYS[1], target, target)
mh_mark()
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

-- '%.0f' and not '%d' for the two timestamps: they are whole numbers held in
-- a double, and '%d' in Lua asks for an integer cast that is a different
-- question on every build
local function mh_write_state(key, field, value, carried, writtenAt, heldThrough)
  redis.call('HSET', key, field,
    string.format('%.17g|%.17g|%.0f|%.0f', value, carried, writtenAt, heldThrough))
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
 * one. `carried` does move when the write lands in the window the pointer
 * names, because that window now ends at this value.
 *
 * KEYS: bucket index, watermark, level hash. ARGV: bucket key prefix,
 * bucketTs, mode, then dimKey/value pairs.
 */
const SET_LEVEL = `${LUA_HELPERS}${LUA_LEVEL_STATE}${LUA_ONCE}
if mh_seen() then return 0 end
local target = mh_landing(KEYS[2], ARGV[2])
local bucketTs = tonumber(target)
local prefix = ARGV[1]
local add = ARGV[3] == 'add'

-- the level one window holds for a series, or nil when it holds nothing
local function level_at(at, field)
  local cur = redis.call('HGET', prefix .. at, field)
  if cur == false then return nil end
  if not mh_is_level(cur) then
    local held = 'counter'
    if mh_parse(cur) ~= false then held = 'gauge' end
    error(redis.error_reply('MHKIND holds ' .. held .. ' cells - set is a level op'))
  end
  return tonumber(string.sub(cur, 2))
end

for i = 4, MH_N, 2 do
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  local state = mh_read_state(KEYS[3], field)
  local landing = level_at(target, field)
  local pointer = bucketTs
  local writtenAt = bucketTs
  if state ~= nil then
    pointer = state[4]
    if state[3] > writtenAt then writtenAt = state[3] end
  end

  -- windows after this one that already hold a value for the series
  local later = {}
  for _, at in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. target, '+inf')) do
    local level = level_at(at, field)
    if level ~= nil then later[#later + 1] = { at, level } end
  end

  -- the same rule as planLevelWrite in the memory driver: an add is a
  -- change that applies from its window onwards, a set is a reading that
  -- only becomes the held value if nothing newer has been written
  local cells = {}
  local value
  local carried
  if add then
    local base = landing
    if base == nil then
      base = 0
      if state ~= nil then
        base = state[2]
        for _, at in ipairs(redis.call('ZREVRANGEBYSCORE', KEYS[1], '(' .. target, '(' .. state[4])) do
          local level = level_at(at, field)
          if level ~= nil then
            base = level
            break
          end
        end
      end
    end
    cells[1] = { target, base + v }
    for _, c in ipairs(later) do cells[#cells + 1] = { c[1], c[2] + v } end
    value = v
    carried = v
    if state ~= nil then
      value = state[1] + v
      carried = state[2]
      if bucketTs <= pointer then carried = state[2] + v end
    end
  else
    cells[1] = { target, v }
    value = v
    carried = v
    if state ~= nil then
      if #later > 0 then value = state[1] end
      local newerAtPointer = false
      for _, c in ipairs(later) do
        if tonumber(c[1]) <= pointer then newerAtPointer = true end
      end
      if bucketTs > pointer or newerAtPointer then carried = state[2] end
    end
  end

  if not mh_finite(value) then return redis.error_reply(MH_RANGE) end
  for _, c in ipairs(cells) do
    if not mh_finite(c[2]) then return redis.error_reply(MH_RANGE) end
  end

  for _, c in ipairs(cells) do
    redis.call('HSET', prefix .. c[1], field, mh_pack_level(c[2]))
    redis.call('ZADD', KEYS[1], c[1], c[1])
  end
  mh_write_state(KEYS[3], field, value, carried, writtenAt, pointer)
end

mh_mark()
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
 * queue that has never existed. A window below the watermark gets no cell,
 * because a claim has taken it already, and the pointer still moves.
 *
 * KEYS: bucket index, watermark, level hash. ARGV: bucket key prefix,
 * bucketTs, then dimKey/value pairs.
 */
const HOLD_LEVEL = `${LUA_HELPERS}${LUA_LEVEL_STATE}
local bucketTs = tonumber(ARGV[2])
local key = ARGV[1] .. ARGV[2]
local wm = redis.call('GET', KEYS[2])
local claimed = wm ~= false and bucketTs < tonumber(wm)
local written = 0

for i = 3, #ARGV, 2 do
  local field = ARGV[i]
  local value = tonumber(ARGV[i + 1])
  local state = mh_read_state(KEYS[3], field)

  if state ~= nil then
    if not claimed and redis.call('HSETNX', key, field, mh_pack_level(value)) == 1 then
      written = written + 1
    end
    -- carried belongs to the pointer's window, so a hold for an older one,
    -- from a flusher whose clock runs behind, leaves both alone
    if bucketTs >= state[4] then
      mh_write_state(KEYS[3], field, state[1], value, state[3], bucketTs)
    end
  end
end

if written > 0 then redis.call('ZADD', KEYS[1], ARGV[2], ARGV[2]) end
return written
`

/**
 * Forget level series, but only those not written since the caller looked.
 *
 * KEYS: level hash. ARGV: writtenBefore, or an empty string to drop
 * unconditionally, then the dim keys.
 */
const DROP_LEVELS = `${LUA_LEVEL_STATE}
local cutoff = tonumber(ARGV[1])
local dropped = 0

for i = 2, #ARGV do
  local field = ARGV[i]
  local keep = false
  if cutoff ~= nil then
    local state = mh_read_state(KEYS[1], field)
    if state ~= nil and state[3] >= cutoff then keep = true end
  end
  if not keep then dropped = dropped + redis.call('HDEL', KEYS[1], field) end
end
return dropped
`

/**
 * Move every bucket strictly below a watermark into one in-flight key.
 *
 * Atomic, so a second flusher racing this one sees an index with those buckets
 * already gone rather than a half-moved window. The claim is registered in the
 * claims ZSET even when it carries nothing, because an empty claim is still a
 * claim that has to be settled exactly once.
 *
 * Raises the stored watermark in the same step, so no write can land below it
 * between the move and the raise.
 *
 * KEYS: index, in-flight hash, claims, watermark. ARGV: watermark, claimId,
 * bucket key prefix. Returns Redis's time and the claimed cells.
 */
const CLAIM_BUCKETS = `${LUA_NOW}
local claimedAt = mh_now()
local wm = redis.call('GET', KEYS[4])
if wm == false or tonumber(ARGV[1]) > tonumber(wm) then
  redis.call('SET', KEYS[4], ARGV[1])
end

local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
for i = 1, #ids do
  local bucketTs = ids[i]
  local data = redis.call('HGETALL', ARGV[3] .. bucketTs)
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
  redis.call('DEL', ARGV[3] .. bucketTs)
  redis.call('ZREM', KEYS[1], bucketTs)
end
redis.call('ZADD', KEYS[3], claimedAt, ARGV[2])
return { claimedAt, redis.call('HGETALL', KEYS[2]) }
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
        redis.call('HSET', key, field, mh_num(tonumber(cur) + tonumber(held)))
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
 * Stage records at the back of the list, each stamped with its place in line.
 *
 * The stamp is a sixteen digit sequence number in front of the JSON, taken
 * from one counter per metric in the same step as the push, so it is the
 * order Redis received the records in across every process. Release reads it
 * to put records back where they came from.
 *
 * KEYS: records, sequence. ARGV: the encoded records.
 */
const APPEND_RECORDS = `${LUA_ONCE}
if mh_seen() then return 0 end
local last = redis.call('INCRBY', KEYS[2], MH_N)
local first = last - MH_N
for i = 1, MH_N, 1000 do
  local chunk = {}
  for j = i, math.min(i + 999, MH_N) do
    chunk[#chunk + 1] = string.format('%016.0f', first + j) .. '|' .. ARGV[j]
  end
  redis.call('RPUSH', KEYS[1], unpack(chunk))
end
mh_mark()
return last
`

/**
 * Put one in-flight record list back at the **front** of the queue.
 *
 * They are older than anything appended while they were in flight, and a claim
 * ships oldest first, so returning them to the back would ship out of order.
 *
 * Not quite the very front, though. A claim that failed before this one may
 * already be back there, and its records can be older than some of these and
 * newer than others, so the two runs are merged. Each record starts with the
 * sequence number {@link APPEND_RECORDS} gave it, fixed width, so comparing the
 * stored strings byte by byte compares arrival order.
 *
 * `LPUSH a b c` leaves `c b a`, so each chunk goes in reversed, and the chunks
 * themselves run back to front — which is what lands the whole run in its
 * original order.
 *
 * Returns how many records it restored.
 */
const LUA_RESTORE_RECORDS = `
local function mh_push_front(list, items)
  local i = #items
  while i >= 1 do
    local chunk = {}
    local stop = math.max(1, i - 999)
    for j = i, stop, -1 do chunk[#chunk + 1] = items[j] end
    redis.call('LPUSH', list, unpack(chunk))
    i = stop - 1
  end
end

-- byte order, not string '<': Lua compares strings with strcoll, and Redis
-- sets the collation locale from its environment
local function mh_before(a, b)
  local n = math.min(#a, #b, 64)
  for k = 1, n do
    local x = string.byte(a, k)
    local y = string.byte(b, k)
    if x ~= y then return x < y end
  end
  return false
end

local function mh_restore_records(inflight, records)
  local held = redis.call('LRANGE', inflight, 0, -1)
  if #held == 0 then return 0 end
  table.sort(held, mh_before)

  -- every record at the front older than the newest of these: records an
  -- earlier release already put back. They can interleave with these, so
  -- the two runs are merged rather than one placed before the other
  local newest = held[#held]
  local older = {}
  local scanned = 0
  while true do
    local page = redis.call('LRANGE', records, scanned, scanned + 99)
    local stopped = false
    for k = 1, #page do
      if mh_before(page[k], newest) then
        older[#older + 1] = page[k]
      else
        stopped = true
        break
      end
    end
    scanned = scanned + #page
    if stopped or #page < 100 then break end
  end

  if #older > 0 then redis.call('LTRIM', records, #older, -1) end
  local merged = {}
  local a = 1
  local b = 1
  while a <= #older or b <= #held do
    if b > #held or (a <= #older and mh_before(older[a], held[b])) then
      merged[#merged + 1] = older[a]
      a = a + 1
    else
      merged[#merged + 1] = held[b]
      b = b + 1
    end
  end
  mh_push_front(records, merged)
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
 * The reply is everything in the in-flight list, not only what this call
 * took, so a claim resent after a reconnect, which runs twice, still hands
 * back every record it holds. Returns Redis's time and the records.
 *
 * KEYS: records, in-flight list, claims. ARGV: limit, claimId.
 */
const CLAIM_RECORDS = `${LUA_NOW}
local claimedAt = mh_now()
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

redis.call('ZADD', KEYS[3], claimedAt, ARGV[2])
return { claimedAt, redis.call('LRANGE', KEYS[2], 0, -1) }
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
const RECOVER_CLAIMS = `${LUA_NOW}${LUA_RESTORE_BUCKETS}${LUA_RESTORE_RECORDS}
local cutoff = mh_now() - tonumber(ARGV[1])
local abandoned = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff, 'WITHSCORES')
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
 * Count a metric's records that have not shipped: staged, and in flight.
 *
 * KEYS: records, claims. ARGV: in-flight key prefix.
 */
const COUNT_PENDING = `
local n = redis.call('LLEN', KEYS[1])
local ids = redis.call('ZRANGE', KEYS[2], 0, -1)
for i = 1, #ids do
  local key = ARGV[1] .. ids[i]
  if redis.call('TYPE', key)['ok'] == 'list' then n = n + redis.call('LLEN', key) end
end
return n
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
    return isDate(raw) ? { [DATE_TAG]: raw.getTime() } : value
  })
}

function decodeRecord(stored: string): StagedRecord {
  // the sequence stamp from APPEND_RECORDS, if there is one. A record staged
  // before stamps existed starts with the JSON itself
  const json = stored.startsWith('{') ? stored : stored.slice(stored.indexOf('|') + 1)
  return JSON.parse(json, (_key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const tagged = value as Record<string, unknown>
    const ms = tagged[DATE_TAG]
    if (typeof ms === 'number' && Object.keys(tagged).length === 1) return new Date(ms)
    return value
  }) as StagedRecord
}

/**
 * A number as Lua printed it.
 *
 * Lua prints the infinities as `inf` and `-inf`, which `Number()` reads as
 * NaN. The scripts refuse to store either, so this only matters for data
 * written before they did.
 */
function numberFrom(raw: string | undefined): number {
  if (raw === 'inf') return Number.POSITIVE_INFINITY
  if (raw === '-inf') return Number.NEGATIVE_INFINITY
  return Number(raw)
}

/** A packed gauge fold, a level's held value, or a counter's scalar. */
function decodeCell(raw: string): Cell {
  if (raw.startsWith('@')) return { level: numberFrom(raw.slice(1)) }

  const parts = raw.split('|')
  if (parts.length !== 5) return numberFrom(raw)
  return {
    last: numberFrom(parts[0]),
    min: numberFrom(parts[1]),
    max: numberFrom(parts[2]),
    sum: numberFrom(parts[3]),
    count: numberFrom(parts[4]),
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
  const range = message.indexOf('MHRANGE')
  if (range !== -1) {
    return new Error(`ioredis driver: ${metric} ${message.slice(range + 'MHRANGE'.length).trim()}`)
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
  // no colon, for the same reason a metric name has none: every key is
  // namespace, a type, then a metric, split on colons. A namespace `org:idx`
  // would make its `org:idx:seq` counter the same key as the index of a
  // metric named `seq` in namespace `org`
  if (typeof ns !== 'string' || !/^[^\s:]+$/.test(ns)) {
    throw new Error(
      `ioredis driver: namespace ${JSON.stringify(ns)} must be non-empty with no colon or ` +
        'whitespace, because the driver builds every key by joining it to the rest with colons',
    )
  }
  const maxPipeline = Math.max(1, options.maxPipelineSize ?? DEFAULT_MAX_PIPELINE)
  const recoverAfterMs = parseDuration(options.recoverAfter ?? DEFAULT_RECOVER_AFTER)

  const key = {
    bucket: (metric: string, bucketTs: number | string) => `${ns}:b:${metric}:${bucketTs}`,
    bucketPrefix: (metric: string) => `${ns}:b:${metric}:`,
    idx: (metric: string) => `${ns}:idx:${metric}`,
    levels: (metric: string) => `${ns}:lvl:${metric}`,
    records: (metric: string) => `${ns}:e:${metric}`,
    recordSeq: (metric: string) => `${ns}:eseq:${metric}`,
    inflight: (claimId: string) => `${ns}:inflight:${claimId}`,
    claims: (metric: string) => `${ns}:claims:${metric}`,
    watermark: (metric: string) => `${ns}:wm:${metric}`,
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
  /** A factory's client is the driver's to close; a passed client is not. */
  const ownsClient = typeof source === 'function'
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
    /**
     * A write that must apply at most once. The script is built with
     * LUA_ONCE, and gets this writer's record key and a sequence number
     * added to its keys and arguments.
     */
    readonly once?: boolean
  }

  /**
   * This driver's identity as a writer, for LUA_ONCE, and the sequence
   * numbers it is still waiting on a reply for. The lowest of those is the
   * floor sent with each write: nothing below it can be resent, so the
   * record of it can go.
   */
  const writerKey = `${ns}:w:${uuidv7(Date.now())}`
  let writeSeq = 0
  const unanswered = new Set<number>()

  /**
   * The last send issued, so the next one waits for it to be issued too.
   *
   * A send may first have to load its script, and a later send whose script
   * is already cached would otherwise reach Redis ahead of it. Two `set()`
   * calls on one level would then land in the wrong order. Only the issuing
   * is queued, never the reply, so pipelining is unaffected.
   */
  let issuing: Promise<unknown> = Promise.resolve()

  function inOrder<T>(issue: () => Promise<{ reply: Promise<T> }>): Promise<T> {
    const issued = issuing.then(issue)
    issuing = issued.catch(() => undefined)
    return issued.then((sent) => sent.reply)
  }

  /**
   * Run scripts pipelined, reloading them if Redis has forgotten.
   *
   * Split into round trips of at most `maxPipelineSize` scripts, as commands
   * are. A level carry can send one script per window, and ten thousand of
   * them in one pipeline is the reply buffer the setting exists to bound.
   *
   * A restart or a `SCRIPT FLUSH` invalidates every cached SHA at once, so the
   * recovery is to drop the whole cache and replay the round trip, rather than
   * unpick which of the calls in it failed. A script that already ran in that
   * round trip is not run twice: NOSCRIPT means it never ran.
   */
  async function runScripts(calls: readonly ScriptCall[], what: string): Promise<unknown[]> {
    if (calls.length === 0) return []
    const client = await connect()

    const out: unknown[] = []
    for (let start = 0; start < calls.length; start += maxPipeline) {
      const chunk = calls.slice(start, start + maxPipeline)
      // one number per write, kept across a NOSCRIPT retry: the retried call
      // is the same write, so if it did run after all, the script sees it
      const seqs = chunk.map((call) => (call.once ? ++writeSeq : 0))
      for (const seq of seqs) if (seq > 0) unanswered.add(seq)

      const send = (
        indexes: readonly number[],
      ): Promise<[error: Error | null, result: unknown][] | null> =>
        inOrder(async () => {
          const resolved = await Promise.all(
            indexes.map((i) => shaFor(client, (chunk[i] as ScriptCall).script)),
          )
          // the floor is taken after the await, as late as possible, so it
          // accounts for every write still waiting at the moment this one goes
          const floor = Math.min(...unanswered)
          const pipeline = client.pipeline()
          indexes.forEach((i, n) => {
            const call = chunk[i] as ScriptCall
            const seq = seqs[i] as number
            const keys = seq > 0 ? [...call.keys, writerKey] : call.keys
            const args = seq > 0 ? [...call.args, floor, seq] : call.args
            pipeline.evalsha(resolved[n] as string, keys.length, ...keys, ...args)
          })
          return { reply: pipeline.exec() }
        })

      try {
        const every = chunk.map((_, i) => i)
        let results = await send(every)
        const missing = every.filter((i) => isNoScript(results?.[i]?.[0]))
        if (results !== null && missing.length > 0) {
          // only the calls Redis did not recognise go again. The others ran,
          // and running them twice is the very thing LUA_ONCE guards against
          shas.clear()
          const retried = await send(missing)
          const merged = [...results]
          missing.forEach((i, n) => {
            merged[i] = retried?.[n] ?? [new Error('ioredis driver: retry was discarded'), null]
          })
          results = merged
        }
        out.push(...unwrap(results, what))
      } finally {
        for (const seq of seqs) if (seq > 0) unanswered.delete(seq)
      }
    }
    return out
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
      // queued behind any write still loading its script, so a read issued
      // after a write sees it
      out.push(...unwrap(await inOrder(async () => ({ reply: pipeline.exec() })), what))
    }
    return out
  }

  async function nextClaimId(metric: string): Promise<string> {
    const client = await connect()
    return `${metric}#${await client.incr(key.seq)}`
  }

  /**
   * Ops grouped by metric and bucket, each group's args flattened in order.
   *
   * One script call per group: one bucket hash, one batch of fields.
   */
  function grouped<Op extends { metric: string; bucketTs: number }>(
    ops: readonly Op[],
    pair: (op: Op) => [string, number],
  ): { metric: string; bucketTs: number; args: (string | number)[] }[] {
    const groups = new Map<
      string,
      { metric: string; bucketTs: number; args: (string | number)[] }
    >()
    for (const op of ops) {
      const groupKey = key.bucket(op.metric, op.bucketTs)
      let group = groups.get(groupKey)
      if (!group) {
        group = { metric: op.metric, bucketTs: op.bucketTs, args: [] }
        groups.set(groupKey, group)
      }
      group.args.push(...pair(op))
    }
    return [...groups.values()]
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

    async close(): Promise<void> {
      if (!ownsClient || connection === undefined) return
      const client = await connection
      connection = undefined
      await client.quit?.()
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

      try {
        await runScripts(
          grouped(ops, (op) => [op.dimKey, op.delta]).map((group) => ({
            script: INCREMENT,
            once: true,
            keys: [key.idx(group.metric), key.watermark(group.metric)],
            args: [key.bucketPrefix(group.metric), group.bucketTs, ...group.args],
          })),
          'increment',
        )
      } catch (error) {
        throw typedError(error, ops[0]?.metric ?? 'unknown')
      }
    },

    async observe(ops: readonly GaugeOp[]): Promise<void> {
      if (ops.length === 0) return

      // grouped by bucket, so each script touches one hash and one batch for
      // that bucket goes in one call
      try {
        await runScripts(
          grouped(ops, (op) => [op.dimKey, op.value]).map((group) => ({
            script: MERGE_GAUGE,
            once: true,
            keys: [key.idx(group.metric), key.watermark(group.metric)],
            args: [key.bucketPrefix(group.metric), group.bucketTs, ...group.args],
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
      // hash, so the held value and the cell it names move together. Only
      // neighbouring ops share a group, so a batch mixing `set` and `add` on
      // one series still applies in the order it was written
      interface Group {
        readonly metric: string
        readonly bucketTs: number
        readonly mode: LevelOp['mode']
        readonly args: (string | number)[]
      }
      const groups: Group[] = []

      for (const op of ops) {
        let group = groups.at(-1)
        if (
          !group ||
          group.mode !== op.mode ||
          group.metric !== op.metric ||
          group.bucketTs !== op.bucketTs
        ) {
          group = { metric: op.metric, bucketTs: op.bucketTs, mode: op.mode, args: [] }
          groups.push(group)
        }
        group.args.push(op.dimKey, op.value)
      }

      try {
        await runScripts(
          groups.map((group) => ({
            script: group.mode === 'hold' ? HOLD_LEVEL : SET_LEVEL,
            // a hold is safe to run twice; a set or an add is not
            once: group.mode !== 'hold',
            keys: [key.idx(group.metric), key.watermark(group.metric), key.levels(group.metric)],
            args: [
              key.bucketPrefix(group.metric),
              group.bucketTs,
              ...(group.mode === 'hold' ? [] : [group.mode]),
              ...group.args,
            ],
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
          value: numberFrom(parts[0]),
          carried: numberFrom(parts[1]),
          writtenAt: Number(parts[2]),
          heldThrough: Number(parts[3]),
        })
      }

      return series.sort((a, b) => (a.dimKey < b.dimKey ? -1 : 1))
    },

    async dropLevels(
      metric: string,
      dimKeys: readonly string[],
      writtenBefore?: number,
    ): Promise<void> {
      if (dimKeys.length === 0) return
      await runScripts(
        [
          {
            script: DROP_LEVELS,
            keys: [key.levels(metric)],
            args: [writtenBefore === undefined ? '' : writtenBefore, ...dimKeys],
          },
        ],
        'dropLevels',
      )
    },

    async append(ops: readonly AppendOp[]): Promise<void> {
      if (ops.length === 0) return

      const byMetric = new Map<string, string[]>()
      for (const op of ops) {
        const encoded = byMetric.get(op.metric)
        if (encoded) encoded.push(encodeRecord(op))
        else byMetric.set(op.metric, [encodeRecord(op)])
      }

      await runScripts(
        [...byMetric].map(([metric, encoded]) => ({
          script: APPEND_RECORDS,
          once: true,
          keys: [key.records(metric), key.recordSeq(metric)],
          args: encoded,
        })),
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
      // LLEN, not an LRANGE the caller counts — the whole reason this is a
      // method of its own. Plus the in-flight lists, which are few
      const [count] = await runScripts(
        [
          {
            script: COUNT_PENDING,
            keys: [key.records(metric), key.claims(metric)],
            args: [key.inflight('')],
          },
        ],
        'countPending',
      )
      return Number(count ?? 0)
    },

    async claim(metric: string, upToBucketTs: number): Promise<BucketClaim> {
      const id = await nextClaimId(metric)

      // stamped by Redis, inside the script: the score in the claims ZSET is
      // what decides whether this claim is stale, and a stamp from this
      // host's clock would be compared later against another host's
      const [reply] = await runScripts(
        [
          {
            script: CLAIM_BUCKETS,
            keys: [key.idx(metric), key.inflight(id), key.claims(metric), key.watermark(metric)],
            args: [upToBucketTs, id, key.bucketPrefix(metric)],
          },
        ],
        'claim',
      )
      const [claimedAt, flat] = (reply ?? [0, []]) as [number, string[]]

      return {
        kind: 'buckets',
        id,
        metric,
        claimedAt: Number(claimedAt),
        buckets: unflatten(flat ?? []),
      }
    },

    async claimRecords(metric: string, limit?: number): Promise<RecordClaim> {
      const id = await nextClaimId(metric)

      const [reply] = await runScripts(
        [
          {
            script: CLAIM_RECORDS,
            keys: [key.records(metric), key.inflight(id), key.claims(metric)],
            args: [limit === undefined ? -1 : Math.max(0, limit), id],
          },
        ],
        'claimRecords',
      )
      const [claimedAt, taken] = (reply ?? [0, []]) as [number, string[]]

      return {
        kind: 'records',
        id,
        metric,
        claimedAt: Number(claimedAt),
        records: (taken ?? []).map(decodeRecord),
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
      // the cutoff is worked out inside the script from Redis's clock, the
      // same clock `claim` stamped the registry with, so "older than the
      // cutoff" never compares two machines' ideas of now

      let raw: unknown
      try {
        const results = await runScripts(
          [
            {
              script: RECOVER_CLAIMS,
              keys: [key.claims(metric), key.idx(metric), key.records(metric)],
              // `inflight('')` rather than a literal, so the prefix cannot
              // drift from the key the claim was actually written to
              args: [recoverAfterMs, key.inflight(''), key.bucketPrefix(metric)],
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
