/**
 * The ioredis driver. Shared, durable storage for open buckets and staged
 * records.
 *
 * Writes go straight to Redis, pipelined, with no local buffer, so every
 * instance contributes to the same bucket and a live read is globally exact.
 * A claim is a real move into a key of its own, so it survives the process
 * that took it, which is what turns the flush guarantee from best-effort into
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
 * everything at the surface, `hincrby` against `hIncrBy`, `pipeline()`
 * against `multi()`, and a driver that pretends otherwise ends up lying about
 * one of them. The name leaves `nodeRedis()` free for whoever wants it, and
 * the {@link describeDriverContract} suite is what will tell them they got it
 * right.
 */

import { uuidv7 } from '../identity.js'
import { hasLoneSurrogate } from '../schema/dims.js'
import { isDate } from '../schema/types.js'
import { type DurationInput, parseDuration } from '../time/duration.js'
import {
  type AppendOp,
  type BucketClaim,
  type BucketQuery,
  type BucketRange,
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
  type ShipTurn,
  type StagedRecord,
  type Turn,
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
   * test runs. The suite gives each driver a random one for exactly that
   * reason. No colon, no whitespace and no half of a surrogate pair, or the
   * constructor throws.
   */
  readonly namespace?: string

  /**
   * How many commands go into one pipelined round trip. Defaults to 1000. A
   * value that is not a positive integer throws at construction.
   *
   * A batch larger than this is split into several round trips. The cap is
   * about the reply buffer. Every round trip of one call is issued before any
   * send made after that call, so this process never puts a write of its own
   * between two of them. Another process can still read or write between
   * them, and each script call is applied or refused on its own: a window
   * with more than 1000 ops in one call is already split into several script
   * calls, and a refusal in one of them keeps the ones that were applied.
   */
  readonly maxPipelineSize?: number

  /**
   * How long a claim may be in flight before {@link Driver.recover} treats it
   * as abandoned by a dead flusher. Defaults to `'5m'`.
   *
   * **Set this above your sink's timeout.** It is the one number that decides
   * whether a claim belongs to a corpse or to a process that is simply taking
   * its time, and there is no way to tell those apart from here. Too low and a
   * slow write has its rows taken back and shipped by someone else. That is a
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
  /** Distinct dim keys currently live for a metric, so cardinality can be watched. */
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

/**
 * The most items one script call carries: field and value pairs, records, or
 * dim keys.
 *
 * Every item is an argument to `evalsha`, and JavaScript passes arguments on
 * the stack, which overflows somewhere past a hundred thousand of them. A
 * bigger batch is split into several calls, pipelined together.
 */
const MAX_PAIRS_PER_SCRIPT = 1000

/** `items` in slices of at most `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size))
  }
  return out
}
const DEFAULT_MAX_PIPELINE = 1000
/** Five minutes. Far longer than any sane sink, which is the point. */
const DEFAULT_RECOVER_AFTER = 300_000

/**
 * The watermark a write is landed by, from the two keys a claim keeps.
 *
 * `mh:wm:<metric>` is the one 0.7.0 reads and raises: the highest window
 * boundary any claim has been handed, which a 0.7 process moves a late write
 * onto as it is. This version keeps its own in the hash `mh:wmown:<metric>`,
 * under `watermark`, as `watermark|mh:wm as it stood`. It is lower while the
 * newest window that held data is older than the boundary claimed, and empty
 * until a claim of this version finds data.
 *
 * The stretch between the two is the gap: windows that were empty when this
 * version last claimed, which a write of this version may still start. A 0.7
 * claim at that same boundary takes such a window without raising `mh:wm`,
 * so every window a write of this version starts in the gap is recorded as a
 * field of the same hash. One recorded and no longer live has been claimed,
 * and a write aimed there moves on, as it would past a watermark. A claim of
 * this version forgets the fields its own watermark has passed.
 *
 * A 0.7 claim that raises `mh:wm` leaves the entry naming an older value,
 * and then the higher of the two counts and there is no gap. With no entry,
 * `mh:wm` is the whole of it, as 0.7.0 or a build between it and this one
 * stored it, on the grid or not.
 */
const LUA_WATERMARK = `
-- this version's watermark or nil, and where the gap ends or nil
local function mh_watermark(wmKey, ownKey)
  local wm = redis.call('GET', wmKey)
  local own = redis.call('HGET', ownKey, 'watermark')
  if own ~= false then
    local mine, beside = string.match(own, '^([^|]*)|(.*)$')
    if mine ~= nil then
      mine = tonumber(mine)
      if wm == false then return mine, nil end
      wm = tonumber(wm)
      if tonumber(beside) == wm then
        if mine == nil or mine < wm then return mine, wm end
        return mine, nil
      end
      if mine ~= nil and mine > wm then return mine, nil end
      return wm, nil
    end
  end
  if wm == false then return nil, nil end
  return tonumber(wm), nil
end

-- true for a window in the gap a write of this version started and a claim
-- has taken since
local function mh_taken(ownKey, idxKey, window)
  return redis.call('HEXISTS', ownKey, window) == 1 and redis.call('ZSCORE', idxKey, window) == false
end

-- the first boundary of a grid of step res at or past floor. fmod, because it
-- is exact for a whole number of milliseconds where Lua's % divides first
local function mh_boundary(floor, res)
  local step = tonumber(res)
  local past = math.fmod(floor, step)
  if past == 0 then return string.format('%.0f', floor) end
  return string.format('%.0f', floor - past + step)
end

-- the window a write aimed at bucketTs actually lands in, and true when that
-- window is in the gap and has to be recorded once the write is made. Every
-- window below the watermark has been claimed already, so a write for one of
-- them goes to the first window of its own resolution at or past the
-- watermark instead, the oldest window of that grid that has not shipped
local function mh_landing(wmKey, ownKey, idxKey, bucketTs, res)
  local floor, gapEnd = mh_watermark(wmKey, ownKey)
  local target = bucketTs
  if floor ~= nil and tonumber(bucketTs) < floor then target = mh_boundary(floor, res) end
  while gapEnd ~= nil and tonumber(target) < gapEnd do
    if not mh_taken(ownKey, idxKey, target) then return target, true end
    target = mh_boundary(tonumber(target) + 1, res)
  end
  return target, false
end

-- true when a claim has taken the window already, and true second when a
-- cell written there has to be recorded as one started in the gap
local function mh_claimed(wmKey, ownKey, idxKey, window)
  local floor, gapEnd = mh_watermark(wmKey, ownKey)
  if floor ~= nil and tonumber(window) < floor then return true, false end
  if gapEnd ~= nil and tonumber(window) < gapEnd then
    if mh_taken(ownKey, idxKey, window) then return true, false end
    return false, true
  end
  return false, false
end
`

/**
 * A gauge fold, packed into one hash field as `last|min|max|sum|count`.
 *
 * `%.17g` and not `%.14g`. Lua's default `tostring` is the latter, and a fold
 * that round-trips through it loses the bottom bits of every `sum` on every
 * observation. Seventeen significant digits is what an f64 needs to survive
 * the trip unchanged.
 */
const LUA_HELPERS = `${LUA_WATERMARK}
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
-- which is otherwise the same digits meaning the opposite thing on a merge.
-- A cell a hold wrote has a space after the '@', and one a write moved to
-- the watermark wrote has a space after the number. 0.7.0 reads all three
-- as the bare number, because Lua's tonumber and JavaScript's Number both
-- skip the space, so a 0.7 process sharing the namespace ships them right
local function mh_pack_level(v, carried, moved)
  local n = string.format('%.17g', v)
  if carried then return '@ ' .. n end
  if moved then return '@' .. n .. ' ' end
  return '@' .. n
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

local MH_RANGE = 'MHRANGE would pass the largest number a metric can store, so the write was refused'
local MH_INT = 'MHRANGE would pass 9007199254740991, the largest whole number a double holds exactly, so the write was refused'

-- true for a whole number a double holds exactly, which is all a metric
-- declared as whole numbers may store
local function mh_safe(x)
  return x == math.floor(x) and x >= -9007199254740991 and x <= 9007199254740991
end

local MH_FRAC = 'MHRANGE would not be a whole number, so the write was refused. The series holds a fraction, which happens when a float metric is declared as an integer one'

-- the reason mh_safe refused: a fraction, or a whole number past the limit
local function mh_int_error(x)
  if x ~= math.floor(x) then return MH_FRAC end
  return MH_INT
end
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
 * it is removed, because nothing below it can be resent. A write the client
 * gave up on without an answer from Redis still counts as waiting, until a
 * later write is answered. The whole record
 * expires a day after its writer's last write.
 *
 * A script whose reply carries information, such as how many claims a
 * recovery put back, passes that reply to `mh_mark`. It is kept beside the
 * number, and `mh_seen` hands it back, so the second arrival answers the way
 * the first did instead of reporting that it found nothing to do.
 *
 * `MH_N` is the index of the last argument that belongs to the script itself.
 */
const LUA_ONCE = `
local MH_N = #ARGV - 2

-- nil when this write has not run yet, otherwise the reply it recorded, or an
-- empty string when it recorded none
local function mh_seen()
  local hit = redis.call('ZRANGEBYSCORE', KEYS[#KEYS], ARGV[#ARGV], ARGV[#ARGV])
  if #hit == 0 then return nil end
  local bar = string.find(hit[1], '|', 1, true)
  if bar == nil then return '' end
  return string.sub(hit[1], bar + 1)
end

local function mh_mark(reply)
  local w = KEYS[#KEYS]
  local member = ARGV[#ARGV]
  if reply ~= nil then member = member .. '|' .. reply end
  redis.call('ZREMRANGEBYSCORE', w, '-inf', '(' .. ARGV[#ARGV - 1])
  redis.call('ZADD', w, ARGV[#ARGV], member)
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
 * KEYS: bucket index, watermark, own watermark. ARGV: bucket key prefix,
 * bucketTs, resolutionMs, `1` when every total must stay a whole number a
 * double holds exactly, then dimKey/delta pairs.
 */
const INCREMENT = `${LUA_HELPERS}${LUA_ONCE}
if mh_seen() then return 0 end
local target, gap = mh_landing(KEYS[2], KEYS[3], KEYS[1], ARGV[2], ARGV[3])
local key = ARGV[1] .. target
local integer = ARGV[4] == '1'
local totals = {}
local order = {}

for i = 5, MH_N, 2 do
  local field = ARGV[i]
  local total = totals[field]
  if total == nil then
    local cur = redis.call('HGET', key, field)
    local parsed = mh_parse(cur)
    if parsed == 'level' then
      return redis.error_reply('MHKIND holds level cells, and increment is a counter op')
    end
    if type(parsed) == 'table' then
      return redis.error_reply('MHKIND holds gauge cells, and increment is a counter op')
    end
    total = 0
    if cur ~= false then total = tonumber(cur) end
    order[#order + 1] = field
  end
  total = total + tonumber(ARGV[i + 1])
  if not mh_finite(total) then return redis.error_reply(MH_RANGE) end
  if integer and not mh_safe(total) then return redis.error_reply(mh_int_error(total)) end
  totals[field] = total
end

for _, field in ipairs(order) do
  redis.call('HSET', key, field, mh_num(totals[field]))
end
redis.call('ZADD', KEYS[1], target, target)
if gap then redis.call('HSET', KEYS[3], target, 1) end
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
 * KEYS: bucket index, watermark, own watermark. ARGV: bucket key prefix,
 * bucketTs, resolutionMs, then dimKey/value pairs.
 */
const MERGE_GAUGE = `${LUA_HELPERS}${LUA_ONCE}
if mh_seen() then return 0 end
local target, gap = mh_landing(KEYS[2], KEYS[3], KEYS[1], ARGV[2], ARGV[3])
local key = ARGV[1] .. target
local folds = {}
local order = {}

for i = 4, MH_N, 2 do
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  local cur = folds[field]

  if cur == nil then
    local parsed = mh_parse(redis.call('HGET', key, field))
    if parsed == false then
      return redis.error_reply('MHKIND holds counter cells, and observe is a gauge op')
    end
    if parsed == 'level' then
      return redis.error_reply('MHKIND holds level cells, and observe is a gauge op')
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
if gap then redis.call('HSET', KEYS[3], target, 1) end
mh_mark()
return 1
`

/**
 * The level state for one series, and the level cells a write reads.
 *
 * The state is packed as `value|carried|writtenAt|heldThrough`, the four
 * fields 0.7.0 stores and reads, so a 0.7 process sharing the namespace
 * during a rolling deploy reads every series a newer one writes. The fifth
 * number a series needs, `carriedFrom`, sits in a hash of its own beside this
 * one, and only when the four cannot say it. See `mh_write_state`.
 *
 * Its own hash per metric, never touched by a claim. That is the whole reason
 * a level can ship a row for a window nobody wrote to: the number outlives
 * the flush that shipped the last one.
 *
 * A series is a table of six, by position rather than by name, because a
 * write builds one per op and a flush one per series per window:
 * `{ value, carried, writtenAt, heldThrough, from, beside }`. `from` is
 * carriedFrom when it is known, and false when it is not. `beside` is true
 * when an entry in the carriedFrom hash may exist for the series.
 */
const LUA_LEVEL_STATE = `
-- the series stored under field, or nil. from is known when a build between
-- 0.7.0 and this one stored it as a fifth field. An entry beside the state
-- needs the newest write to be past the pointer
local function mh_read_state(key, field)
  local raw = redis.call('HGET', key, field)
  if raw == false then return nil end
  local v, c, w, h = string.match(raw, '^([^|]+)|([^|]+)|([^|]+)|([^|]+)$')
  if v ~= nil then
    w = tonumber(w)
    h = tonumber(h)
    return { tonumber(v), tonumber(c), w, h, false, w > h }
  end
  local f
  v, c, w, h, f = string.match(raw, '^([^|]+)|([^|]+)|([^|]+)|([^|]+)|([^|]+)$')
  if v == nil then return nil end
  return { tonumber(v), tonumber(c), tonumber(w), tonumber(h), tonumber(f), false }
end

-- carriedFrom, the window of the newest write at or before the pointer.
-- When the newest write of all is at or before the pointer, it is that one.
-- Otherwise it is the entry beside the state, if that entry was worked out
-- against the pointer and carried value the state still holds, and the
-- pointer when not: the latest that write can be, so an expiry is never
-- measured from too early. The state was stored in the same formats the
-- entry is checked in, so formatting its numbers again gives the same text
local function mh_carried_from(fromKey, field, st)
  if st[5] then return st[5] end
  if st[3] <= st[4] then return st[3] end
  local raw = redis.call('HGET', fromKey, field)
  if raw ~= false then
    local f, h, c = string.match(raw, '^([^|]+)|([^|]+)|([^|]+)$')
    if f ~= nil and h == string.format('%.0f', st[4]) and c == string.format('%.17g', st[2]) then
      return tonumber(f)
    end
  end
  return st[4]
end

-- '%.0f' and not '%d' for the timestamps: they are whole numbers held in a
-- double, and '%d' in Lua asks for an integer cast that is a different
-- question on every build.
--
-- A from of false leaves the entry beside the state alone: the write left
-- carriedFrom, the pointer and carried as they were. Otherwise the entry is
-- written only when the four fields cannot say carriedFrom, which is when the
-- newest write is past the pointer and the newest one at or before it is
-- older than the pointer. It names the pointer and the carried value it was
-- worked out against, so a 0.7 process that moves either makes it stale
-- rather than wrong
local function mh_write_state(key, fromKey, field, st)
  redis.call('HSET', key, field, string.format('%.17g|%.17g|%.0f|%.0f', st[1], st[2], st[3], st[4]))
  if not st[5] then return end
  if st[3] > st[4] and st[5] < st[4] then
    redis.call('HSET', fromKey, field, string.format('%.0f|%.0f|%.17g', st[5], st[4], st[2]))
  elseif st[6] then
    redis.call('HDEL', fromKey, field)
  end
end

-- the number in a level cell, and its mark: 1 when a hold wrote it, 2 when a
-- write moved to the watermark did, 0 otherwise. A build between 0.7.0 and
-- this one marked a carried cell '@c'. 32 is a space and 99 a 'c'
local function mh_level(v)
  local second = string.byte(v, 2)
  if second == 32 or second == 99 then return tonumber(string.sub(v, 3)), 1 end
  if string.byte(v, -1) == 32 then return tonumber(string.sub(v, 2, -2)), 2 end
  return tonumber(string.sub(v, 2)), 0
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
 * The pointer is left alone by a write after it. Windows between this write
 * and the previous one are still owed a row, and only a hold may say they
 * have had one. A write before it, with no cell between the two, moves it
 * back, because the windows between are owed a row too. `carried` moves when
 * the write lands at or before the window the pointer names, because that
 * window now ends at a different value.
 *
 * Every op in a call lands in the same window, so the windows after it, and
 * those between a pointer and it, are read once for the call rather than
 * once per op. A write only ever adds the window it lands in.
 *
 * KEYS: bucket index, watermark, level hash, carriedFrom hash, own watermark.
 * ARGV: bucket key prefix, bucketTs, resolutionMs, mode, `1` when every level
 * must stay a whole number a double holds exactly, the level's holdFor or an
 * empty string, then dimKey/value pairs.
 */
const SET_LEVEL = `${LUA_HELPERS}${LUA_LEVEL_STATE}${LUA_ONCE}
if mh_seen() then return 0 end
local target, gap = mh_landing(KEYS[2], KEYS[5], KEYS[1], ARGV[2], ARGV[3])
local bucketTs = tonumber(target)
local moved = bucketTs ~= tonumber(ARGV[2])
local prefix = ARGV[1]
local add = ARGV[4] == 'add'
local integer = ARGV[5] == '1'
local holdFor = tonumber(ARGV[6])

-- nothing is written until every op in the call has been worked out and
-- checked, so a refusal changes nothing, and a resend of a refused call is
-- refused again rather than applying its first half twice. An op reads what
-- the ops before it planned, as it would read what they wrote. A planned
-- cell is its number and its mark, keyed by window and field
local cellValue = {}
local cellMark = {}
local cellOrder = {}
local statePlan = {}
local stateOrder = {}

-- the level one window holds for a series and its mark, or nil when it
-- holds nothing
local function level_at(at, field)
  local slot = at .. ':' .. field
  local planned = cellValue[slot]
  if planned ~= nil then return planned, cellMark[slot] end
  local cur = redis.call('HGET', prefix .. at, field)
  if cur == false then return nil, 0 end
  if not mh_is_level(cur) then
    local held = 'counter'
    if mh_parse(cur) ~= false then held = 'gauge' end
    error(redis.error_reply('MHKIND holds ' .. held .. ' cells, and set is a level op'))
  end
  return mh_level(cur)
end

-- a cell to write
local function plan_cell(at, field, v, mark)
  local slot = at .. ':' .. field
  if cellValue[slot] == nil then cellOrder[#cellOrder + 1] = { at, field, slot } end
  cellValue[slot] = v
  cellMark[slot] = mark
end

-- the refusal for a number a cell or the held value would take, or nil
local function refused(x)
  if not mh_finite(x) then return MH_RANGE end
  if integer and not mh_safe(x) then return mh_int_error(x) end
  return nil
end

-- the windows after this one. Each keeps the text Redis stored beside its
-- number, and cells are keyed by that text, because Lua prints a timestamp
-- of fifteen digits in a shorter form that names another key
local laterWindows = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. target, '+inf')
-- the windows strictly between a pointer and this one, newest first, by
-- pointer. Nearly always there are none
local between = {}

-- one op after another, in the main chunk rather than in a function per op:
-- a function here would capture a score of the locals above as upvalues,
-- and building those on every call costs more than the rest of the op. The
-- same rules as planLevelWrite in the memory driver: an add is a change that
-- applies from its window onwards, a set is a reading that replaces the
-- carried cells after it and only becomes the held value if nothing newer
-- has been written. A break skips the op
for i = 7, MH_N, 2 do repeat
  local field = ARGV[i]
  local v = tonumber(ARGV[i + 1])
  local state = statePlan[field]
  if state == nil then state = mh_read_state(KEYS[3], field) end
  local landing, landingMark = level_at(target, field)

  -- a set moved forward to the watermark is older than a reading taken in
  -- the window it lands in, and changes nothing. A set moved there before
  -- it is no newer than this one, which replaces it
  if not add and moved and landingMark == 0 and landing ~= nil then break end

  -- windows after this one that already hold a value for the series:
  -- { window as stored, number, mark, window as a number }
  local later = {}
  for _, at in ipairs(laterWindows) do
    local level, mark = level_at(at, field)
    if level ~= nil then later[#later + 1] = { at, level, mark, tonumber(at) } end
  end

  local pointer = bucketTs
  local writtenAt = bucketTs
  local carriedFrom = bucketTs
  local beside = true
  local expired = false
  local back = false
  if state ~= nil then
    pointer = state[4]
    beside = state[6]
    if state[3] > writtenAt then writtenAt = state[3] end
    expired = holdFor ~= nil and state[3] + holdFor < bucketTs
    if bucketTs < pointer and landing == nil then
      back = true
      for _, c in ipairs(later) do
        if c[4] < pointer then back = false end
      end
    end
    if back then
      carriedFrom = bucketTs
    elseif bucketTs <= pointer then
      carriedFrom = mh_carried_from(KEYS[4], field, state)
      if bucketTs > carriedFrom then carriedFrom = bucketTs end
    elseif state[5] or state[3] <= state[4] then
      carriedFrom = mh_carried_from(KEYS[4], field, state)
    else
      -- past the pointer, which leaves the pointer, carried and carriedFrom
      -- as they were, and the entry beside the state with them
      carriedFrom = false
    end
  end
  local heldThrough = pointer
  if back then heldThrough = bucketTs end

  local value = v
  local carried = v
  if add then
    local base = landing
    if base == nil then
      base = 0
      if state ~= nil and bucketTs >= pointer then
        -- the value in effect just before this window: the newest cell
        -- between the pointer and here, or what the pointer carried. Unless
        -- the series had passed holdFor by this window, measured from the
        -- newest write before it rather than from writtenAt, so an add that
        -- arrives late into a stretch where the series had expired starts
        -- from zero
        local found = between[pointer]
        if found == nil then
          -- '%.0f', because Lua's own number format keeps fourteen digits
          -- and would move this bound for a timestamp of fifteen
          local after = '(' .. string.format('%.0f', pointer)
          found = redis.call('ZREVRANGEBYSCORE', KEYS[1], '(' .. target, after)
          between[pointer] = found
        end
        local before = nil
        local lastWrite = nil
        for _, at in ipairs(found) do
          local level, mark = level_at(at, field)
          if level ~= nil then
            if before == nil then before = level end
            if mark ~= 1 then lastWrite = tonumber(at) end
            if holdFor == nil or lastWrite ~= nil then break end
          end
        end
        if before == nil then before = state[2] end
        if holdFor == nil then
          base = before
        else
          if lastWrite == nil then lastWrite = mh_carried_from(KEYS[4], field, state) end
          if lastWrite + holdFor >= bucketTs then base = before end
        end
      end
    end

    local cell = base + v
    local why = refused(cell)
    if why ~= nil then return redis.error_reply(why) end
    -- moved only while nothing in this window's own time has written here
    local mark = 0
    if moved and (landing == nil or landingMark ~= 0) then mark = 2 end
    plan_cell(target, field, cell, mark)
    for _, c in ipairs(later) do
      why = refused(c[2] + v)
      if why ~= nil then return redis.error_reply(why) end
      plan_cell(c[1], field, c[2] + v, c[3])
    end
    if state ~= nil then
      if not expired then value = state[1] + v end
      if back then
        carried = base + v
      elseif bucketTs <= pointer then
        carried = state[2] + v
      else
        carried = state[2]
      end
    end
  else
    local why = refused(v)
    if why ~= nil then return redis.error_reply(why) end
    local written = nil
    for _, c in ipairs(later) do
      if c[3] ~= 1 then
        written = c[4]
        break
      end
    end
    local mark = 0
    if moved then mark = 2 end
    plan_cell(target, field, v, mark)
    for _, c in ipairs(later) do
      if c[3] == 1 and (written == nil or c[4] < written) then plan_cell(c[1], field, v, 1) end
    end
    if state ~= nil then
      if written ~= nil then value = state[1] end
      if not back and not (bucketTs <= pointer and (written == nil or written > pointer)) then
        carried = state[2]
      end
    end
  end

  local why = refused(value)
  if why ~= nil then return redis.error_reply(why) end

  if statePlan[field] == nil then stateOrder[#stateOrder + 1] = field end
  statePlan[field] = { value, carried, writtenAt, heldThrough, carriedFrom, beside }
until true end

for _, c in ipairs(cellOrder) do
  local mark = cellMark[c[3]]
  redis.call('HSET', prefix .. c[1], c[2], mh_pack_level(cellValue[c[3]], mark == 1, mark == 2))
  redis.call('ZADD', KEYS[1], c[1], c[1])
  if gap and c[1] == target then
    redis.call('HSET', KEYS[5], target, 1)
    gap = false
  end
end
for _, field in ipairs(stateOrder) do
  mh_write_state(KEYS[3], KEYS[4], field, statePlan[field])
end

mh_mark()
return 1
`

/**
 * Carry each series into one window that has no cell yet.
 *
 * The value it writes is the one in effect just before the window, read here
 * rather than taken from the call: the newest cell between the pointer and
 * this window, or `carried`. The flush worked its values out from a read a
 * moment older, and a set that landed since has to reach every window after
 * it. The windows of one flush arrive in ascending order, so each one reads
 * what the one before it wrote.
 *
 * Write-if-absent, so an observed value always beats a carried one: a set
 * that raced this hold into the same window keeps the number somebody
 * actually wrote, and `carried` takes that number too.
 *
 * Safe to run twice for the same reason: a second arrival finds the cell the
 * first one wrote, or a newer one, and carries what it finds.
 *
 * A series the metric asked to hold but storage has never seen is skipped.
 * There is nothing to carry, and a zero would put a line on a chart for a
 * queue that has never existed. A window below the watermark gets no cell,
 * because a claim has taken it already, and the pointer still moves, carrying
 * the value the call names.
 *
 * The windows between a pointer and this one are read once per pointer
 * rather than once per series. A flush holds every series from the same
 * pointer, and there are nearly always none.
 *
 * KEYS: bucket index, watermark, level hash, carriedFrom hash, own watermark.
 * ARGV: bucket key prefix, bucketTs, then dimKey/value pairs.
 */
const HOLD_LEVEL = `${LUA_HELPERS}${LUA_LEVEL_STATE}
local bucketTs = tonumber(ARGV[2])
local key = ARGV[1] .. ARGV[2]
local claimed, gap = mh_claimed(KEYS[2], KEYS[5], KEYS[1], ARGV[2])
local written = 0

-- the level cell one window holds for a series and its mark, or nil when it
-- holds none
local function level_at(at, field)
  local cur = redis.call('HGET', ARGV[1] .. at, field)
  if cur == false then return nil, 0 end
  if not mh_is_level(cur) then
    local held = 'counter'
    if mh_parse(cur) ~= false then held = 'gauge' end
    error(redis.error_reply('MHKIND holds ' .. held .. ' cells, and set is a level op'))
  end
  return mh_level(cur)
end

local betweenCache = {}
local function windows_between(pointer)
  local found = betweenCache[pointer]
  if found == nil then
    local after = '(' .. string.format('%.0f', pointer)
    found = redis.call('ZREVRANGEBYSCORE', KEYS[1], '(' .. ARGV[2], after)
    betweenCache[pointer] = found
  end
  return found
end

for i = 3, #ARGV, 2 do
  local field = ARGV[i]
  local state = mh_read_state(KEYS[3], field)

  if state ~= nil then
    local pointer = state[4]
    if claimed then
      -- the claim took the cells between the pointer and here, and any write
      -- among them, so the newest write is taken to be as late as it can be:
      -- writtenAt, or this window when that is earlier. Both are past
      -- carriedFrom, which is at or before the pointer. A hold for the
      -- pointer's own window arriving again once a claim has taken it leaves
      -- carried alone: the cell that says what it ended at is gone, and
      -- carried has it
      if bucketTs > pointer then
        state[5] = math.min(state[3], bucketTs)
        state[2] = tonumber(ARGV[i + 1])
        state[4] = bucketTs
        mh_write_state(KEYS[3], KEYS[4], field, state)
      end
    elseif bucketTs < pointer then
      -- carried belongs to the pointer's window, so a hold for an older one,
      -- from a flusher whose clock runs behind, fills it if it is empty and
      -- moves nothing
      if level_at(bucketTs, field) == nil then
        redis.call('HSET', key, field, mh_pack_level(tonumber(ARGV[i + 1]), true, false))
        written = written + 1
      end
    else
      -- the newest cell, and the newest written one, between the pointer and
      -- this window
      local before = nil
      local newestWrite = nil
      if bucketTs > pointer then
        for _, at in ipairs(windows_between(pointer)) do
          local level, mark = level_at(at, field)
          if level ~= nil then
            if before == nil then before = level end
            if mark ~= 1 then
              newestWrite = tonumber(at)
              break
            end
          end
        end
      end

      local carried = before
      if carried == nil then carried = state[2] end
      local from = newestWrite
      if redis.call('HSETNX', key, field, mh_pack_level(carried, true, false)) == 1 then
        written = written + 1
      else
        local cell, mark = level_at(bucketTs, field)
        carried = cell
        if mark ~= 1 then from = bucketTs end
      end
      if from == nil then from = mh_carried_from(KEYS[4], field, state) end
      state[2] = carried
      state[4] = bucketTs
      state[5] = from
      mh_write_state(KEYS[3], KEYS[4], field, state)
    end
  end
end

if written > 0 then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[2])
  if gap then redis.call('HSET', KEYS[5], ARGV[2], 1) end
end
return written
`

/**
 * Rewrite level series a build between 0.7.0 and this one stored with
 * `carriedFrom` as a fifth field into the four fields 0.7.0 reads, with the
 * entry beside them when the four cannot say it.
 *
 * A series is rewritten only while it still holds the text the caller read,
 * so one a 0.7 process wrote since is left as that process stored it.
 *
 * KEYS: level hash, carriedFrom hash. ARGV: dimKey and stored text pairs.
 */
const REWRITE_LEVELS = `${LUA_LEVEL_STATE}
for i = 1, #ARGV, 2 do
  local field = ARGV[i]
  if redis.call('HGET', KEYS[1], field) == ARGV[i + 1] then
    local state = mh_read_state(KEYS[1], field)
    if state ~= nil then
      -- an entry beside it can only be left over from before, and goes
      state[6] = true
      mh_write_state(KEYS[1], KEYS[2], field, state)
    end
  end
end
return 1
`

/**
 * Forget level series, but only those not written since the caller looked,
 * and the carriedFrom beside each one.
 *
 * KEYS: level hash, carriedFrom hash. ARGV: writtenBefore, or an empty string
 * to drop unconditionally, then the dim keys.
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
  if not keep then
    dropped = dropped + redis.call('HDEL', KEYS[1], field)
    redis.call('HDEL', KEYS[2], field)
  end
end
return dropped
`

/**
 * Move every bucket strictly below a watermark, and every bucket at or past
 * `aheadFrom` when one is given, into one in-flight key.
 *
 * Atomic, so a second flusher racing this one sees an index with those buckets
 * already gone rather than a half-moved window. The claim is registered in the
 * claims ZSET even when it carries nothing, because an empty claim is still a
 * claim that has to be settled exactly once.
 *
 * Raises both watermarks in the same step, so no write can land below them
 * between the move and the raise. The one 0.7.0 reads rises to the watermark
 * handed in, as a 0.7 claim raises it, so it stays on the metric's grid and
 * a 0.7 process moves a late write onto a window a row can name. This
 * version's own rises no higher than one past the newest live window, unless
 * the claim took a window past that bound, and a claim that finds no live
 * window leaves it where it was. The memory driver's claim says why. See
 * `mh_watermark` for how the two are stored.
 *
 * A level cell a build between 0.7.0 and this one marked carried with a `c`
 * moves as `@ ` and its number, the mark 0.7.0 reads past, so a 0.7 process
 * that recovers the claim ships the number.
 *
 * KEYS: index, in-flight hash, claims, watermark, own watermark. ARGV:
 * watermark, claimId, bucket key prefix, aheadFrom or an empty string.
 * Returns Redis's time and the claimed cells.
 */
const CLAIM_BUCKETS = `${LUA_NOW}${LUA_WATERMARK}
local claimedAt = mh_now()
local upTo = tonumber(ARGV[1])
local newest = redis.call('ZREVRANGE', KEYS[1], 0, 0)

local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
if ARGV[4] ~= '' then
  local from = string.format('%.0f', math.max(tonumber(ARGV[4]), upTo))
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], from, '+inf')) do
    ids[#ids + 1] = id
  end
end

local own = mh_watermark(KEYS[4], KEYS[5])
if #newest > 0 then
  local raised = math.min(upTo, tonumber(newest[1]) + 1)
  if #ids > 0 then raised = math.max(raised, tonumber(ids[#ids]) + 1) end
  if own == nil or raised > own then own = raised end
end
local wm = redis.call('GET', KEYS[4])
if wm == false or upTo > tonumber(wm) then
  wm = string.format('%.0f', upTo)
  redis.call('SET', KEYS[4], wm)
end
local ownText = ''
if own ~= nil then ownText = string.format('%.0f', own) end
redis.call('HSET', KEYS[5], 'watermark', ownText .. '|' .. wm)
-- the windows recorded in the gap that the gap no longer holds
if redis.call('HLEN', KEYS[5]) > 1 then
  local gapEnd = tonumber(wm)
  for _, field in ipairs(redis.call('HKEYS', KEYS[5])) do
    local at = tonumber(field)
    if at ~= nil and ((own ~= nil and at < own) or at >= gapEnd) then
      redis.call('HDEL', KEYS[5], field)
    end
  end
end

for i = 1, #ids do
  local bucketTs = ids[i]
  local data = redis.call('HGETALL', ARGV[3] .. bucketTs)
  local flat = {}
  for j = 1, #data, 2 do
    local v = data[j + 1]
    -- '@c', a 64 and a 99
    if string.byte(v, 2) == 99 and string.byte(v, 1) == 64 then v = '@ ' .. string.sub(v, 3) end
    flat[#flat + 1] = bucketTs .. ':' .. data[j]
    flat[#flat + 1] = v
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
 * all, which is what makes a double ack an error instead of a silent no-op.
 *
 * Applied once, like a write. An ack whose reply was lost is resent, and the
 * second arrival would find the claim already gone and report it as never
 * having been in flight, turning a successful flush into an error.
 *
 * KEYS: claims, in-flight. ARGV: claimId.
 */
const ACK_CLAIM = `${LUA_ONCE}
if mh_seen() then return 1 end
if redis.call('ZREM', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('DEL', KEYS[2])
mh_mark()
return 1
`

/**
 * Put one in-flight bucket hash back into the live set.
 *
 * Merge, never overwrite: a write can land in a bucket while it is claimed,
 * backdated, or a straggler from another instance, and overwriting would drop
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

    -- a level cell a build between 0.7.0 and this one marked '@c' goes back
    -- with the mark 0.7.0 reads past, as a claim moves it
    if string.byte(held, 2) == 99 and string.byte(held, 1) == 64 then
      held = '@ ' .. string.sub(held, 3)
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
 * themselves run back to front, which is what lands the whole run in its
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

-- the sequence stamp in front of a stored record, or an empty string for a
-- record staged before stamps existed, which starts with its JSON. The rule
-- stampOf keeps in the driver, so an unstamped record sorts before every
-- stamped one here as it does there
local function mh_stamp(record)
  if string.sub(record, 1, 1) == '{' then return '' end
  local bar = string.find(record, '|', 1, true)
  if bar == nil then return record end
  return string.sub(record, 1, bar - 1)
end

-- byte order of the stamps, not string '<': Lua compares strings with
-- strcoll, and Redis sets the collation locale from its environment
local function mh_before(a, b)
  local sa = mh_stamp(a)
  local sb = mh_stamp(b)
  local n = math.min(#sa, #sb)
  for k = 1, n do
    local x = string.byte(sa, k)
    local y = string.byte(sb, k)
    if x ~= y then return x < y end
  end
  return #sa < #sb
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
 * Applied once, as {@link ACK_CLAIM} is. The claim stays registered until
 * every cell is back: a restore that aborts on a cell of another kind leaves
 * the rest of the claim where a retried release, or a recovery pass, still
 * finds it, rather than in a key nothing names.
 *
 * KEYS: claims, in-flight hash, index. ARGV: claimId, bucket key prefix.
 */
const RELEASE_BUCKETS = `${LUA_RESTORE_BUCKETS}${LUA_ONCE}
if mh_seen() then return 1 end
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then return 0 end
mh_restore_buckets(KEYS[2], ARGV[2], KEYS[3])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
mh_mark()
return 1
`

/**
 * Move staged records into a claim, oldest first.
 *
 * No watermark: a record is complete the instant it is appended. `limit` is
 * what bounds a backlog larger than the sink will take, and `-1` means all of
 * it.
 *
 * Applied once. A claim resent after a reconnect would otherwise take a
 * second `limit` of records into the same in-flight list. The second arrival
 * takes nothing, and replies with the time the first one recorded and
 * everything the list holds. Returns Redis's time and the records.
 *
 * KEYS: records, in-flight list, claims. ARGV: limit, claimId.
 */
const CLAIM_RECORDS = `${LUA_NOW}${LUA_ONCE}
local replayed = mh_seen()
if replayed then return { tonumber(replayed), redis.call('LRANGE', KEYS[2], 0, -1) } end

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
mh_mark(string.format('%.0f', claimedAt))
return { claimedAt, redis.call('LRANGE', KEYS[2], 0, -1) }
`

/**
 * Settle a record claim by putting the records back.
 *
 * Applied once, as {@link ACK_CLAIM} is.
 *
 * KEYS: records, in-flight list, claims. ARGV: claimId.
 */
const RELEASE_RECORDS = `${LUA_RESTORE_RECORDS}${LUA_ONCE}
if mh_seen() then return 1 end
if redis.call('ZREM', KEYS[3], ARGV[1]) == 0 then return 0 end
mh_restore_records(KEYS[2], KEYS[1])
redis.call('DEL', KEYS[2])
mh_mark()
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
 * Applied once, with its counts recorded. A recovery resent after a reconnect
 * would otherwise find nothing left to recover and report zero claims, which
 * hides the crash that stranded them.
 *
 * KEYS: claims, index, records. ARGV: cutoff, in-flight prefix, bucket prefix.
 */
const RECOVER_CLAIMS = `${LUA_NOW}${LUA_RESTORE_BUCKETS}${LUA_RESTORE_RECORDS}${LUA_ONCE}
local replayed = mh_seen()
if replayed then
  local c, b, r, o = string.match(replayed, '^(%d+),(%d+),(%d+),(%d+)$')
  return { tonumber(c), tonumber(b), tonumber(r), tonumber(o) }
end

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

-- a pass that found nothing has nothing to repeat, and nearly every pass is
-- one, so only a pass that put something back leaves a record
if claims > 0 then
  mh_mark(string.format('%.0f,%.0f,%.0f,%.0f', claims, buckets, records, oldest))
end
return { claims, buckets, records, oldest }
`

/**
 * Take a metric's turn to ship, if the last one is far enough away.
 *
 * The rule {@link Driver.takeTurn} states, checked and recorded in one step.
 * The time is the caller's, not Redis's: a turn is compared with the clock
 * the flush reads, the one a test can inject. Hosts whose clocks disagree
 * move the gap by that much. The flush asks for a gap a tenth shorter than
 * its cadence, so a disagreement smaller than that tenth, or a cron firing a
 * little earlier within its minute than last time, still gets the turn.
 *
 * Applied once, with its answer recorded. A turn resent after a reconnect
 * would otherwise find the one it had just taken in its way and be refused,
 * and the flush would skip while holding a turn nobody gives back.
 *
 * The turn key holds the time alone, the layout 0.7.0 reads, so a process of
 * that version on the same namespace can still take and give back turns. The
 * token sits in a key beside it, written in the same step. A 0.7.0 process
 * writes the time and leaves that key alone, so its turns read with whatever
 * token was there before. One taken in the same millisecond as a newer
 * process's is told apart by time alone, as 0.7.0 did. A turn stored as
 * `at|token`, the layout of a build between 0.7.0 and this one, is read as
 * that turn and rewritten into the two keys.
 *
 * KEYS: turn, token. ARGV: now, gapMs, the new turn's token. Returns `1` or
 * `0` for granted, and the turn recorded before this one as `at|token`, or an
 * empty string when there was none.
 */
const TAKE_TURN = `${LUA_ONCE}
local replayed = mh_seen()
if replayed then
  local granted, last = string.match(replayed, '^(%d),(.*)$')
  return { tonumber(granted), last }
end

local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local stored = redis.call('GET', KEYS[1])
local last = ''
local granted = 1
if stored then
  local at, token = string.match(stored, '^([^|]*)|(.*)$')
  if at then
    redis.call('SET', KEYS[1], at)
    if token == '' then
      redis.call('DEL', KEYS[2])
    else
      redis.call('SET', KEYS[2], token)
    end
  else
    at = stored
    token = redis.call('GET', KEYS[2]) or ''
  end
  last = at .. '|' .. token
  local elapsed = now - tonumber(at)
  if elapsed < gap and -elapsed < gap then granted = 0 end
end
if granted == 1 then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[3])
end

mh_mark(granted .. ',' .. last)
return { granted, last }
`

/**
 * Give back a turn that shipped nothing, while it is still the one recorded.
 * Compared by time and token, so a turn taken later in the same millisecond is
 * left alone. The recorded turn is read the way {@link TAKE_TURN} reads it, an
 * `at|token` one included, and whatever is put back is written as the time and
 * the token key.
 *
 * KEYS: turn, token. ARGV: the time and token of the turn being given back,
 * then the time and token of the one to restore, the time empty to clear it.
 */
const RETURN_TURN = `${LUA_ONCE}
if mh_seen() then return 1 end

local stored = redis.call('GET', KEYS[1])
if stored then
  local at, token = string.match(stored, '^([^|]*)|(.*)$')
  if not at then
    at = stored
    token = redis.call('GET', KEYS[2]) or ''
  end
  if at == ARGV[1] and token == ARGV[2] then
    if ARGV[3] == '' then
      redis.call('DEL', KEYS[1], KEYS[2])
    else
      redis.call('SET', KEYS[1], ARGV[3])
      if ARGV[4] == '' then
        redis.call('DEL', KEYS[2])
      else
        redis.call('SET', KEYS[2], ARGV[4])
      end
    end
  end
end
mh_mark()
return 1
`

/**
 * One page of the staged list, starting after the last record the caller has
 * already read.
 *
 * A bounded `readPending` reads the list a page at a time, and another process
 * can claim from the front or release to it between two pages, moving every
 * record's position. Paging by position would then skip records or read them
 * twice. So each page starts after a record rather than at an index: the
 * caller's guess at where that record now is, checked, and a search for it
 * when the list has moved. A record that has been claimed since is not found,
 * and the page starts from the front again. Returns where the page started,
 * whether that was a restart, and the page.
 *
 * KEYS: records. ARGV: the last record read or an empty string, the index it
 * was read at, the page size.
 */
const READ_PAGE = `
local after = ARGV[1]
local size = tonumber(ARGV[3])
local start = 0
local restarted = 0

if after ~= '' then
  local guess = tonumber(ARGV[2])
  if redis.call('LINDEX', KEYS[1], guess) == after then
    start = guess + 1
  else
    restarted = 1
    local n = redis.call('LLEN', KEYS[1])
    for i = 0, n - 1, 1000 do
      local chunk = redis.call('LRANGE', KEYS[1], i, i + 999)
      local found = false
      for k = 1, #chunk do
        if chunk[k] == after then
          start = i + k
          restarted = 0
          found = true
          break
        end
      end
      if found then break end
    end
  end
end

return { start, restarted, redis.call('LRANGE', KEYS[1], start, start + size - 1) }
`

/**
 * The sequence stamp {@link APPEND_RECORDS} put in front of a stored record,
 * fixed width so two compare as text. A record staged before stamps existed
 * has none, and sorts before every stamped one.
 */
function stampOf(stored: string): string {
  return stored.startsWith('{') ? '' : stored.slice(0, stored.indexOf('|'))
}

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
 * One series' cells across a range of windows, in one round trip.
 *
 * Reads only, so a resend after a reconnect answers the same way and nothing
 * needs recording. `pcall` rather than `call`, and the error handed back as
 * it came, so a bad bound or a key of the wrong type fails with the words
 * Redis uses for the plain command.
 *
 * KEYS: bucket index. ARGV: bucket key prefix, lower bound, upper bound, dim
 * key. Returns bucketTs and raw cell pairs, oldest window first.
 */
const READ_SERIES = `
local buckets = redis.pcall('ZRANGEBYSCORE', KEYS[1], ARGV[2], ARGV[3])
if buckets.err then return buckets end
local out = {}
for i = 1, #buckets do
  local raw = redis.pcall('HGET', ARGV[1] .. buckets[i], ARGV[4])
  if type(raw) == 'table' and raw.err then return raw end
  if raw then
    out[#out + 1] = buckets[i]
    out[#out + 1] = raw
  end
end
return out
`

/**
 * The window a write aimed at a bucket would land in now, by the same
 * `mh_landing` every write script calls, so a read and a write cannot
 * disagree about it. Reads only.
 *
 * KEYS: watermark, own watermark, bucket index. ARGV: bucketTs, resolutionMs.
 */
const LANDING = `${LUA_HELPERS}
return mh_landing(KEYS[1], KEYS[2], KEYS[3], ARGV[1], ARGV[2])
`

/**
 * Every counter cell across a range of windows, added up where they live.
 *
 * Answers only when the answer is exact whatever order the cells are added
 * in, so it is the number adding them one by one in JavaScript gives. That
 * holds when every cell is a whole number, the positive cells add up to less
 * than 2^53 and the negative ones to more than -2^53: every partial sum then
 * lies between the two, where a double holds every whole number. A cell of any
 * other shape, or a sum past either limit, returns nil, and the caller reads
 * the cells instead.
 *
 * KEYS: bucket index. ARGV: bucket key prefix, lower bound, upper bound.
 */
const SUM_COUNTS = `
local buckets = redis.pcall('ZRANGEBYSCORE', KEYS[1], ARGV[2], ARGV[3])
if buckets.err then return buckets end
local pos = 0
local neg = 0
for i = 1, #buckets do
  local cells = redis.pcall('HVALS', ARGV[1] .. buckets[i])
  if cells.err then return false end
  for j = 1, #cells do
    local raw = cells[j]
    if not string.match(raw, '^%-?%d+$') then return false end
    local x = tonumber(raw)
    if x >= 0 then pos = pos + x else neg = neg + x end
    if pos > 9007199254740991 or neg < -9007199254740991 then return false end
  end
end
return string.format('%.17g', pos + neg)
`

/**
 * Marks an encoded `Date` inside a record's fields.
 *
 * `fields` is opaque to the driver, but it is not opaque to `JSON`: a `ts()`
 * field reaches storage as a real `Date`, and plain `JSON.stringify` would
 * hand it back as a string. The metric would then put that string in the row
 * where a `Date` belongs. That is a difference from the memory driver that nothing
 * would report, so the contract suite pins it.
 */
const DATE_TAG = '__mh_date'

/**
 * What every key the driver reserves starts with.
 *
 * A key of the caller's own that starts with it is stored with the prefix
 * written twice, and loses one copy on the way back. So `{ __mh_date: 5 }`
 * inside a field is stored as `{ __mh___mh_date: 5 }` and can never be read
 * back as a `Date`.
 */
const RESERVED_PREFIX = '__mh_'

/** What a key of the caller's that starts with {@link RESERVED_PREFIX} is stored as. */
const ESCAPED_PREFIX = RESERVED_PREFIX + RESERVED_PREFIX

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isDate(value)
}

/**
 * True when the replacer in {@link encodeRecord} would hand every value back
 * untouched, so plain `JSON.stringify` writes the same bytes.
 *
 * That holds for a string or a number id and ts, and for fields in an ordinary
 * object whose keys do not start with the reserved prefix and whose values are
 * all strings, numbers, booleans, null or undefined. The replacer returns a
 * primitive as it came, NaN, the infinities and `-0` included, and so does a
 * string that happens to read like the date tag. Anything else, a Date, a
 * nested object, an array, a boxed number, takes the replacer. An event
 * stores its json fields as text, so its records are nearly always flat.
 */
function isFlatRecord(op: AppendOp): boolean {
  if (typeof op.id !== 'string' || typeof op.ts !== 'number') return false
  const fields: unknown = op.fields
  if (fields === null || typeof fields !== 'object') return false
  const proto = Object.getPrototypeOf(fields)
  if (proto !== Object.prototype && proto !== null) return false
  for (const key of Object.keys(fields)) {
    if (key.startsWith(RESERVED_PREFIX)) return false
    const value = (fields as Record<string, unknown>)[key]
    const type = typeof value
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && value != null) {
      return false
    }
  }
  return true
}

/**
 * A record as the text Redis stores. Exported for the tests, which hold it to
 * the bytes {@link encodeRecordTagged} writes. The package entry does not
 * export it.
 */
export function encodeRecord(op: AppendOp): string {
  // the replacer is called once per value, which makes a stringify with one
  // more than twice as slow, and a flat record has nothing for it to do
  if (isFlatRecord(op)) return JSON.stringify({ id: op.id, ts: op.ts, fields: op.fields })
  return encodeRecordTagged(op)
}

/** The full encoding, which tags a Date and escapes a reserved key. */
export function encodeRecordTagged(op: AppendOp): string {
  return JSON.stringify({ id: op.id, ts: op.ts, fields: op.fields }, function (key, value) {
    // `value` has already been through Date.prototype.toJSON by the time a
    // replacer sees it. The original is only reachable through `this`
    const raw = (this as Record<string, unknown>)[key]
    // an invalid Date has no time, and JSON writes its NaN as null
    if (isDate(raw)) return { [DATE_TAG]: Number.isNaN(raw.getTime()) ? null : raw.getTime() }
    if (!isPlainObject(value) || !Object.keys(value).some((k) => k.startsWith(RESERVED_PREFIX))) {
      return value
    }
    // fromEntries rather than assignment, so an own `__proto__` key stays a key
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.startsWith(RESERVED_PREFIX) ? RESERVED_PREFIX + k : k,
        v,
      ]),
    )
  })
}

/** The JSON of a stored record, after the sequence stamp if it has one. */
function recordJson(stored: string): string {
  // the sequence stamp from APPEND_RECORDS, if there is one. A record staged
  // before stamps existed starts with the JSON itself
  return stored.startsWith('{') ? stored : stored.slice(stored.indexOf('|') + 1)
}

/**
 * A stored record, back as the record. Exported for the tests, which hold it
 * to what {@link decodeRecordTagged} returns. The package entry does not
 * export it.
 */
export function decodeRecord(stored: string): StagedRecord {
  const json = recordJson(stored)
  // the reviver only changes an object with a key that starts with the
  // reserved prefix, and JSON.stringify never escapes an underscore, so text
  // without that prefix in quotes has nothing for it to do. Skipping it makes
  // a parse about five times faster
  if (!json.includes(`"${RESERVED_PREFIX}`)) return JSON.parse(json) as StagedRecord
  return decodeRecordTagged(stored)
}

/** The full decoding, which restores a tagged Date and a reserved key. */
export function decodeRecordTagged(stored: string): StagedRecord {
  return JSON.parse(recordJson(stored), (_key, value) => {
    if (!isPlainObject(value)) return value
    const keys = Object.keys(value)
    const ms = value[DATE_TAG]
    if (keys.length === 1 && keys[0] === DATE_TAG && (typeof ms === 'number' || ms === null)) {
      return new Date(ms ?? Number.NaN)
    }
    // only a key with the prefix written twice was escaped. One with it once
    // was stored as it is, by a driver from before keys were escaped, and
    // comes back as it went in
    if (!keys.some((k) => k.startsWith(ESCAPED_PREFIX))) return value
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.startsWith(ESCAPED_PREFIX) ? k.slice(RESERVED_PREFIX.length) : k,
        v,
      ]),
    )
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

/**
 * A level series from its packed field, and the `carriedFrom` entry stored
 * beside it if there is one, or `undefined` for a field of any other shape,
 * which is left unread.
 *
 * The field is `value|carried|writtenAt|heldThrough`, as 0.7.0 stores it, or
 * the same with `carriedFrom` as a fifth part, as a build between that one
 * and this stored it. With four parts, `carriedFrom` is read the way the Lua
 * reads it in `mh_carried_from`.
 */
function levelSeriesFrom(
  dimKey: string,
  packed: string,
  beside: string | undefined,
): LevelSeries | undefined {
  return levelSeriesOf(dimKey, packed.split('|'), beside)
}

/** {@link levelSeriesFrom}, from the field already split at each `|`. */
function levelSeriesOf(
  dimKey: string,
  parts: readonly string[],
  beside: string | undefined,
): LevelSeries | undefined {
  if (parts.length !== 4 && parts.length !== 5) return undefined
  const writtenAt = Number(parts[2])
  const heldThrough = Number(parts[3])
  return {
    dimKey,
    value: numberFrom(parts[0]),
    carried: numberFrom(parts[1]),
    writtenAt,
    heldThrough,
    carriedFrom:
      parts.length === 5
        ? Number(parts[4])
        : carriedFromOf(writtenAt, heldThrough, parts[1] as string, parts[3] as string, beside),
  }
}

/**
 * `carriedFrom` for a series stored in four parts.
 *
 * The newest write, when it is at or before the pointer. Otherwise the entry
 * beside the series, when it names the pointer and carried value the series
 * still holds, and the pointer when it does not: a 0.7 process has moved the
 * series since, and the pointer is the latest that write can be.
 */
function carriedFromOf(
  writtenAt: number,
  heldThrough: number,
  carriedText: string,
  heldText: string,
  beside: string | undefined,
): number {
  if (writtenAt <= heldThrough) return writtenAt
  const entry = beside?.split('|')
  if (entry?.length === 3 && entry[1] === heldText && entry[2] === carriedText) {
    return Number(entry[0])
  }
  return heldThrough
}

/**
 * A packed gauge fold, a level cell, or a counter's scalar.
 *
 * A level cell is `@` and its number. A carried one has a space after the
 * `@`, or a `c` from a build between 0.7.0 and this one, and a moved one has
 * a space after the number.
 */
function decodeCell(raw: string): Cell {
  if (raw.startsWith('@')) {
    const mark = raw[1]
    if (mark === ' ' || mark === 'c') return { level: numberFrom(raw.slice(2)), carried: true }
    if (raw.endsWith(' ')) return { level: numberFrom(raw.slice(1, -1)), moved: true }
    return { level: numberFrom(raw.slice(1)) }
  }

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

/**
 * The turn {@link TAKE_TURN} answers with, `at|token`, or `undefined` for none.
 * One 0.7.0 took, which has no token, comes back with an empty one.
 */
function turnFrom(stored: string): Turn | undefined {
  if (stored === '') return undefined
  const bar = stored.indexOf('|')
  if (bar === -1) return { at: Number(stored), token: '' }
  return { at: Number(stored.slice(0, bar)), token: stored.slice(bar + 1) }
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOSCRIPT')
}

/**
 * Did Redis itself answer this entry of a pipeline's results?
 *
 * A value, or an error Redis replied with, which ioredis names `ReplyError`.
 * Anything else, a timeout, a closed connection, a request out of retries, the
 * client raised on its own, and the command may still reach Redis later.
 */
function answered(entry: [error: Error | null, result: unknown] | undefined): boolean {
  if (entry === undefined) return false
  return entry[0] === null || entry[0].name === 'ReplyError'
}

/**
 * Turn a Redis-side type complaint into the error the memory driver raises.
 *
 * Two kinds reach here. A gauge script detects the clash itself and says
 * `MHKIND`; a counter's `HINCRBYFLOAT` just fails to parse the packed fold and
 * says "hash value is not a float", which is true and unhelpful.
 *
 * Only the methods whose scripts fold or restore cells pass their errors
 * through here: `increment`, `observe`, `setLevel`, `release` and `recover`.
 * Those are the ones a series holding another kind of cell can refuse. Every
 * other method raises what Redis or the client raised.
 */
function typedError(error: unknown, metric: string): Error {
  const message = error instanceof Error ? error.message : String(error)

  for (const tag of ['MHKIND', 'MHRANGE']) {
    const at = message.indexOf(tag)
    if (at !== -1) {
      return new Error(`ioredis driver: ${metric} ${message.slice(at + tag.length).trim()}`)
    }
  }
  if (message.includes('not a float') || message.includes('not an integer')) {
    return new Error(
      `ioredis driver: ${metric} holds gauge or level cells, and increment is a counter op`,
    )
  }
  return error instanceof Error ? error : new Error(message)
}

export function ioredis(source: IoredisSource, options: IoredisDriverOptions = {}): IoredisDriver {
  const ns = options.namespace ?? DEFAULT_NAMESPACE
  // no colon, for the same reason a metric name has none: every key is
  // namespace, a type, then a metric, split on colons. A namespace `org:e`
  // would store an event named `checkout` at the same key as an event named
  // `e:checkout` in namespace `org`
  if (typeof ns !== 'string' || !/^[^\s:]+$/.test(ns)) {
    throw new Error(
      `ioredis driver: namespace ${JSON.stringify(ns)} must be non-empty with no colon or ` +
        'whitespace, because the driver builds every key by joining it to the rest with colons',
    )
  }
  // Redis keeps a key as UTF-8, which cannot hold half of a surrogate pair,
  // and ioredis sends one as the replacement character. `mh\uD800` and
  // `mh\uDC00` would then share every key
  if (hasLoneSurrogate(ns)) {
    throw new Error(
      `ioredis driver: namespace ${JSON.stringify(ns)} holds half of a surrogate pair, ` +
        'which Redis would store as the same replacement character for every such namespace',
    )
  }
  const maxPipeline = options.maxPipelineSize ?? DEFAULT_MAX_PIPELINE
  // `NaN`, from `Number()` of a variable that is not set, would split every
  // batch into nothing and send no command at all while reporting success
  if (!Number.isSafeInteger(maxPipeline) || maxPipeline <= 0) {
    throw new Error(
      `ioredis driver: maxPipelineSize must be a positive integer, got ${String(maxPipeline)}`,
    )
  }
  const recoverAfterMs = parseDuration(options.recoverAfter ?? DEFAULT_RECOVER_AFTER)

  const key = {
    bucket: (metric: string, bucketTs: number | string) => `${ns}:b:${metric}:${bucketTs}`,
    bucketPrefix: (metric: string) => `${ns}:b:${metric}:`,
    idx: (metric: string) => `${ns}:idx:${metric}`,
    levels: (metric: string) => `${ns}:lvl:${metric}`,
    levelsFrom: (metric: string) => `${ns}:lvlfrom:${metric}`,
    records: (metric: string) => `${ns}:e:${metric}`,
    recordSeq: (metric: string) => `${ns}:eseq:${metric}`,
    inflight: (claimId: string) => `${ns}:inflight:${claimId}`,
    claims: (metric: string) => `${ns}:claims:${metric}`,
    watermark: (metric: string) => `${ns}:wm:${metric}`,
    ownWatermark: (metric: string) => `${ns}:wmown:${metric}`,
    turn: (metric: string) => `${ns}:turn:${metric}`,
    turnToken: (metric: string) => `${ns}:turntok:${metric}`,
  }

  /**
   * Resolved once and reused.
   *
   * A factory is called on first write rather than at module scope, so
   * importing a schema file never opens a socket, which is what makes the
   * same module safe to load in a build step or a test that never writes.
   */
  let connection: Promise<IoredisClient> | undefined
  /** A factory's client is the driver's to close; a passed client is not. */
  const ownsClient = typeof source === 'function'
  /**
   * The client, from the factory's first success.
   *
   * A factory that fails is not remembered as the answer. Every call waiting
   * on that attempt gets its error, and the next call asks the factory again,
   * so a failure at cold start, a secret not yet readable or a DNS name not yet
   * resolving, does not fail every write for the rest of the process.
   */
  function connect(): Promise<IoredisClient> {
    if (!connection) {
      const attempt = new Promise<IoredisClient>((resolve) => {
        resolve(typeof source === 'function' ? source() : source)
      })
      connection = attempt
      // registered before any caller can wait on it, so it runs first and a
      // caller that retries from its own catch reaches the factory again
      attempt.catch(() => {
        if (connection === attempt) connection = undefined
      })
    }
    return connection
  }

  /** Script source -> SHA1, filled by the first call that needs it. */
  const shas = new Map<string, string>()
  /**
   * Script source -> the load still on its way, shared by every call that
   * asks meanwhile. A first level carry sends one script per window, and
   * without this each of a thousand windows loaded the same script again.
   */
  const loading = new Map<string, Promise<string>>()

  function shaFor(client: IoredisClient, script: string): Promise<string> {
    const cached = shas.get(script)
    if (cached !== undefined) return Promise.resolve(cached)

    let load = loading.get(script)
    if (load === undefined) {
      load = Promise.resolve(client.script('LOAD', script)).then((reply) => {
        const sha = String(reply)
        shas.set(script, sha)
        return sha
      })
      const settled = load
      // forgotten once settled either way, so a failed load is tried again
      const forget = () => {
        if (loading.get(script) === settled) loading.delete(script)
      }
      settled.then(forget, forget)
      loading.set(script, settled)
    }
    return load
  }

  /**
   * The SHA of each script, handed back without waiting when every one is
   * cached already, which is every send after the first. Waiting on a
   * promise per script cost a turn of the microtask queue and a handful of
   * allocations on every single write.
   */
  function shasFor(
    client: IoredisClient,
    scripts: readonly string[],
  ): string[] | Promise<string[]> {
    const known: string[] = []
    for (const script of scripts) {
      const sha = shas.get(script)
      if (sha === undefined) return Promise.all(scripts.map((one) => shaFor(client, one)))
      known.push(sha)
    }
    return known
  }

  /**
   * Which call in a {@link runScripts} batch an error came from, so a write
   * spanning several metrics names the one that was refused rather than the
   * first one in the batch.
   */
  const failedCall = new WeakMap<object, number>()

  function unwrap(
    results: [error: Error | null, result: unknown][] | null,
    what: string,
    offset = 0,
  ): unknown[] {
    if (results === null) throw new Error(`ioredis driver: ${what} pipeline was discarded`)

    return results.map(([error, value], index) => {
      if (error) {
        failedCall.set(error, offset + index)
        throw error
      }
      return value
    })
  }

  /** The metric of the call an error came from, or of the first op. */
  function metricOf(error: unknown, calls: readonly { metric: string }[]): string {
    const index = typeof error === 'object' && error !== null ? failedCall.get(error) : undefined
    return calls[index ?? 0]?.metric ?? 'unknown'
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
   * The lowest sequence number that may still be waiting, found by walking
   * forward from where the last search stopped. Numbers are handed out in
   * order and never reused, so the walk only ever moves forward, and finding
   * the floor costs next to nothing however many writes are in flight. A scan
   * of the whole set on every send was quadratic in a burst.
   */
  let lowestWaiting = 1

  /**
   * Writes Redis never answered, keyed by the round trip that last carried
   * them, and kept in {@link unanswered} until it is safe to forget them.
   *
   * A write whose promise failed without an answer from Redis, because it
   * timed out or its connection closed, can still reach Redis: ioredis resends
   * what it never heard back about after a reconnect. Dropping its number
   * would let the floor pass it, a later write would erase its record, and the
   * resend would apply it a second time. Redis answers a connection's commands
   * in the order they were sent, and ioredis resends them in that order, ahead
   * of anything newer. So once a round trip sent after it has an answer, the
   * write has run or been dropped for good, and its number can go.
   */
  const unsettled = new Map<number, number[]>()
  /** Round trips issued, in the order they reached the client. */
  let issued = 0

  /** Forget the writes carried by round trips issued before `trip`. */
  function settleBefore(trip: number): void {
    for (const [earlier, seqs] of unsettled) {
      if (earlier >= trip) continue
      for (const seq of seqs) unanswered.delete(seq)
      unsettled.delete(earlier)
    }
  }

  function floorOfUnanswered(): number {
    while (lowestWaiting <= writeSeq && !unanswered.has(lowestWaiting)) lowestWaiting += 1
    return lowestWaiting
  }

  /**
   * The last send issued, so the next one waits for it to be issued too.
   *
   * A send may first have to load its script, and a later send whose script
   * is already cached would otherwise reach Redis ahead of it. Two `set()`
   * calls on one level would then land in the wrong order. Only the issuing
   * is queued, never the reply, so pipelining is unaffected.
   */
  let issuing: Promise<unknown> = Promise.resolve()

  /**
   * The resend of the scripts Redis forgot, while one is under way. Nothing
   * is issued until it has gone, see {@link resendForgotten}.
   */
  let resending: Promise<void> | undefined

  /** Resolve once no resend is under way. */
  async function afterResends(): Promise<void> {
    while (resending !== undefined) await resending
  }

  function inOrder<T>(issue: () => Promise<{ reply: Promise<T> }>): Promise<T> {
    // checked when the turn comes rather than when it is queued, and only
    // waited on when there is a resend, so a send costs no extra turn of the
    // microtask queue the rest of the time
    const issued = issuing.then(() =>
      resending === undefined ? issue() : afterResends().then(issue),
    )
    issuing = issued.catch(() => undefined)
    return issued.then((sent) => sent.reply)
  }

  /**
   * One read, issued only after every send made before it.
   *
   * A read sent straight to the client could reach Redis ahead of a write
   * that was made first but is still loading its script, and would miss it.
   */
  function afterSends<T>(read: () => Promise<T>): Promise<T> {
    return inOrder(async () => ({ reply: read() }))
  }

  type Entry = [error: Error | null, result: unknown]
  type Results = Entry[] | null

  /** One call of a {@link runScripts} batch, and how far it has got. */
  interface Sent {
    readonly call: ScriptCall
    /**
     * Its LUA_ONCE sequence number, or 0 for a call that is not a write. Kept
     * across a resend: the resent call is the same write, so if it did run
     * after all, the script sees it.
     */
    readonly seq: number
    /** The round trip that last carried it. */
    trip?: number
    /** Whether Redis answered it on that round trip. */
    heard: boolean
    /** The answer to its resend, once Redis has refused it with NOSCRIPT. */
    resent?: Promise<Entry>
  }

  /** Round trips of scripts issued and not yet answered. */
  const unreplied = new Set<Promise<Results>>()

  /**
   * Calls Redis refused with NOSCRIPT, with the round trip that carried them
   * and their place in it, waiting for {@link resendForgotten}.
   */
  let forgotten: { sent: Sent; trip: number; at: number; answer: (entry: Entry) => void }[] = []

  /** One round trip carrying `sents`, issued now. */
  function issueTrip(
    client: IoredisClient,
    sents: readonly Sent[],
    resolved: readonly string[],
    floor: number,
    resend: boolean,
  ): Promise<Results> {
    const pipeline = client.pipeline()
    sents.forEach(({ call, seq }, n) => {
      const keys = seq > 0 ? [...call.keys, writerKey] : call.keys
      const args = seq > 0 ? [...call.args, floor, seq] : call.args
      pipeline.evalsha(resolved[n] as string, keys.length, ...keys, ...args)
    })
    const trip = ++issued
    for (const sent of sents) {
      sent.trip = trip
      sent.heard = false
    }
    const reply = pipeline.exec().then((results) => {
      sents.forEach((sent, n) => {
        sent.heard = answered(results?.[n])
      })
      if (sents.some((sent) => sent.heard)) settleBefore(trip)
      // a resend refused again is the caller's error, as a load that fails is
      if (!resend) {
        sents.forEach((sent, n) => {
          if (isNoScript(results?.[n]?.[0])) sent.resent = forget(client, sent, trip, n)
        })
      }
      return results
    })
    unreplied.add(reply)
    const done = () => {
      unreplied.delete(reply)
    }
    reply.then(done, done)
    return reply
  }

  /** Queue a call Redis refused with NOSCRIPT for the next resend, and its answer. */
  function forget(client: IoredisClient, sent: Sent, trip: number, at: number): Promise<Entry> {
    const answer = new Promise<Entry>((resolve) => {
      forgotten.push({ sent, trip, at, answer: resolve })
    })
    // set before this returns, so nothing is issued from here on until the
    // resend has gone
    resending ??= resendForgotten(client)
    return answer
  }

  /**
   * Send again every call Redis refused because it had forgotten the script,
   * in the order the calls were first sent, ahead of anything newer.
   *
   * A restart or a `SCRIPT FLUSH` invalidates every cached SHA at once, so the
   * whole cache goes and each script is loaded again. Only the calls refused
   * go again. The others ran, and running them twice is the very thing
   * LUA_ONCE guards against, while NOSCRIPT means a call never ran.
   *
   * Every round trip issued before the first refusal was seen is answered
   * first, so every refusal among them is known, and nothing new is issued
   * meanwhile. Otherwise a call made after one refused call, but before the
   * reply refusing another, would land ahead of that other one's resend, and
   * a level would end on the older of the two values.
   */
  async function resendForgotten(client: IoredisClient): Promise<void> {
    try {
      while (unreplied.size > 0) await Promise.allSettled([...unreplied])
      const batch = forgotten.sort((a, b) => a.trip - b.trip || a.at - b.at)
      forgotten = []
      shas.clear()
      let resolved: string[]
      try {
        resolved = await Promise.all(batch.map(({ sent }) => shaFor(client, sent.call.script)))
      } catch (error) {
        for (const { answer } of batch) answer([error as Error, null])
        return
      }
      // taken after the load, as late as possible, as for any other send
      const floor = floorOfUnanswered()
      for (let start = 0; start < batch.length; start += maxPipeline) {
        const part = batch.slice(start, start + maxPipeline)
        issueTrip(
          client,
          part.map(({ sent }) => sent),
          resolved.slice(start, start + part.length),
          floor,
          true,
        ).then(
          (results) => {
            part.forEach(({ answer }, n) => {
              answer(results?.[n] ?? [new Error('ioredis driver: retry was discarded'), null])
            })
          },
          (error: unknown) => {
            for (const { answer } of part) answer([error as Error, null])
          },
        )
      }
    } finally {
      resending = undefined
    }
  }

  /**
   * Run scripts pipelined, reloading them if Redis has forgotten.
   *
   * Split into round trips of at most `maxPipelineSize` scripts, as commands
   * are. A level carry can send one script per window, and ten thousand of
   * them in one pipeline is the reply buffer the setting exists to bound.
   * A call Redis refused because it forgot the script is sent again by
   * {@link resendForgotten}, and its answer there is the one returned.
   */
  async function runScripts(calls: readonly ScriptCall[], what: string): Promise<unknown[]> {
    if (calls.length === 0) return []
    const client = await connect()

    const sents: Sent[] = calls.map((call) => ({
      call,
      seq: call.once ? ++writeSeq : 0,
      heard: false,
    }))
    for (const { seq } of sents) if (seq > 0) unanswered.add(seq)

    /**
     * Every round trip in `trips` issued in one queued step, so no send made
     * after this one reaches Redis between two of them, and a call split
     * across round trips still lands in the order it was made.
     */
    const send = (trips: readonly (readonly number[])[]): Promise<Promise<Results>[]> =>
      inOrder(async () => {
        const scripts = trips.flat().map((i) => (sents[i] as Sent).call.script)
        let resolved: string[]
        for (;;) {
          const found = shasFor(client, scripts)
          resolved = Array.isArray(found) ? found : await found
          // a resend that began while this loaded a script goes first
          if (resending === undefined) break
          await afterResends()
        }
        // the floor is taken after the await, as late as possible, so it
        // accounts for every write still waiting at the moment this one goes
        const floor = floorOfUnanswered()
        let at = 0
        const replies = trips.map((trip) => {
          const reply = issueTrip(
            client,
            trip.map((i) => sents[i] as Sent),
            resolved.slice(at, at + trip.length),
            floor,
            false,
          )
          at += trip.length
          // awaited in order below, and a rejection waiting its turn there
          // must not be reported as unhandled meanwhile
          reply.catch(() => undefined)
          return reply
        })
        return { reply: Promise.resolve(replies) }
      })

    const trips: number[][] = []
    for (let start = 0; start < calls.length; start += maxPipeline) {
      trips.push(
        Array.from({ length: Math.min(maxPipeline, calls.length - start) }, (_, n) => start + n),
      )
    }

    const out: unknown[] = []
    // the first refusal, thrown once every round trip has been answered, so
    // none of them is left running with nothing waiting on it
    let failure: { error: unknown } | undefined
    try {
      const replies = await send(trips)
      const answers: ({ results: Results } | { error: unknown })[] = []
      for (const reply of replies) {
        try {
          answers.push({ results: await reply })
        } catch (error) {
          answers.push({ error })
        }
      }

      for (const [t, indexes] of trips.entries()) {
        const answer = answers[t] as { results: Results } | { error: unknown }
        if (!('results' in answer)) {
          failure ??= { error: answer.error }
          continue
        }
        let results = answer.results
        if (results !== null && indexes.some((i) => (sents[i] as Sent).resent !== undefined)) {
          const first = results
          results = await Promise.all(
            indexes.map((i, n) => (sents[i] as Sent).resent ?? (first[n] as Entry)),
          )
        }
        try {
          // one at a time: a spread passes every reply as an argument, and
          // a pipeline of a hundred thousand replies overflows the stack
          for (const reply of unwrap(results, what, indexes[0])) out.push(reply)
        } catch (error) {
          failure ??= { error }
        }
      }
    } finally {
      for (const { seq, heard, trip } of sents) {
        if (seq === 0) continue
        if (heard) {
          unanswered.delete(seq)
          continue
        }
        // never answered, possibly never sent: kept until a later round
        // trip is answered, or for good when it was not sent at all
        if (trip === undefined) {
          unanswered.delete(seq)
          continue
        }
        const parked = unsettled.get(trip)
        if (parked) parked.push(seq)
        else unsettled.set(trip, [seq])
      }
    }
    if (failure !== undefined) throw failure.error
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
      const replies = unwrap(await inOrder(async () => ({ reply: pipeline.exec() })), what)
      for (const reply of replies) out.push(reply)
    }
    return out
  }

  /** Run one script and return its reply. */
  async function runScript(call: ScriptCall, what: string): Promise<unknown> {
    const [reply] = await runScripts([call], what)
    return reply
  }

  /**
   * A claim id no other claim has had, minted here rather than by Redis.
   *
   * A counter in Redis rolls back when Redis loses its most recent writes, to
   * a restart between two syncs or a failover to a replica that was behind,
   * and would then hand out an id a claim still in flight already has. The
   * two claims would share one in-flight key, and whichever settled first
   * would settle the other with it. A UUID version 7 needs nothing Redis
   * remembers. Claims taken under the old `metric#n` ids recover and settle
   * as before, since nothing reads an id back apart from the key it names.
   */
  function nextClaimId(metric: string): string {
    return `${metric}#${uuidv7(Date.now())}`
  }

  /**
   * A claim script's reply: when Redis stamped the claim, and what it took.
   * A missing reply reads as a claim of nothing at time zero.
   */
  function claimReply(reply: unknown): { claimedAt: number; taken: string[] } {
    const [claimedAt, taken] = (reply ?? [0, []]) as [number, string[] | undefined]
    return { claimedAt: Number(claimedAt), taken: taken ?? [] }
  }

  /**
   * Refuse to settle a claim the script found no longer in flight.
   *
   * @throws when `settled` is `0`, the reply ACK_CLAIM and both release
   * scripts give for a claim that was acked, released or recovered already
   */
  function assertSettled(settled: unknown, claim: Claim): void {
    if (settled === 0) {
      throw new Error(`ioredis driver: claim ${claim.id} is not in flight. Was it already settled?`)
    }
  }

  /** One script call's worth of ops, as {@link grouped} builds them. */
  interface OpGroup<Op> {
    /** The op that opened the group. */
    readonly first: Op
    readonly metric: string
    readonly bucketTs: number
    readonly resolutionMs: number
    readonly integer: boolean
    readonly args: (string | number)[]
  }

  /**
   * Neighbouring ops for one metric and bucket, each group's args flattened
   * in order.
   *
   * One script call per group: one bucket hash, one batch of fields. Only
   * neighbours share a group, so the groups run in the order the ops were
   * written. Ops aimed at two different windows below the watermark both land
   * at the watermark, and folding them there out of order would give a gauge
   * the wrong `last` and a float counter a sum in the wrong order.
   *
   * `apart` names anything else that keeps an op out of the group before it,
   * given the op that opened that group.
   */
  function grouped<
    Op extends { metric: string; bucketTs: number; resolutionMs: number; integer?: boolean },
  >(
    ops: readonly Op[],
    pair: (op: Op) => [string, number],
    apart: (op: Op, first: Op) => boolean = () => false,
  ): OpGroup<Op>[] {
    const groups: OpGroup<Op>[] = []
    for (const op of ops) {
      let group = groups.at(-1)
      if (
        !group ||
        group.metric !== op.metric ||
        group.bucketTs !== op.bucketTs ||
        group.resolutionMs !== op.resolutionMs ||
        group.integer !== (op.integer === true) ||
        group.args.length >= MAX_PAIRS_PER_SCRIPT * 2 ||
        apart(op, group.first)
      ) {
        group = {
          first: op,
          metric: op.metric,
          bucketTs: op.bucketTs,
          resolutionMs: op.resolutionMs,
          integer: op.integer === true,
          args: [],
        }
        groups.push(group)
      }
      const [field, value] = pair(op)
      group.args.push(field, value)
    }
    return groups
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
      // taken and cleared before the await, so a second close() running
      // alongside finds nothing left to quit
      const closing = connection
      connection = undefined
      await (await closing).quit?.()
    },

    async scanSeries(metric: string): Promise<string[]> {
      const client = await connect()
      const buckets = await afterSends(() => client.zrangebyscore(key.idx(metric), '-inf', '+inf'))
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

      const groups = grouped(ops, (op) => [op.dimKey, op.delta])
      try {
        await runScripts(
          groups.map((group) => ({
            script: INCREMENT,
            once: true,
            keys: [
              key.idx(group.metric),
              key.watermark(group.metric),
              key.ownWatermark(group.metric),
            ],
            args: [
              key.bucketPrefix(group.metric),
              group.bucketTs,
              group.resolutionMs,
              group.integer ? 1 : 0,
              ...group.args,
            ],
          })),
          'increment',
        )
      } catch (error) {
        throw typedError(error, metricOf(error, groups))
      }
    },

    async observe(ops: readonly GaugeOp[]): Promise<void> {
      if (ops.length === 0) return

      // grouped by bucket, so each script touches one hash and one batch for
      // that bucket goes in one call
      const groups = grouped(ops, (op) => [op.dimKey, op.value])
      try {
        await runScripts(
          groups.map((group) => ({
            script: MERGE_GAUGE,
            once: true,
            keys: [
              key.idx(group.metric),
              key.watermark(group.metric),
              key.ownWatermark(group.metric),
            ],
            args: [
              key.bucketPrefix(group.metric),
              group.bucketTs,
              group.resolutionMs,
              ...group.args,
            ],
          })),
          'observe',
        )
      } catch (error) {
        throw typedError(error, metricOf(error, groups))
      }
    },

    async setLevel(ops: readonly LevelOp[]): Promise<void> {
      if (ops.length === 0) return

      // grouped by bucket for the same reason `observe` is: one script, one
      // hash, so the held value and the cell it names move together. Only
      // neighbouring ops share a group, and a change of mode starts a new one,
      // so a batch mixing `set` and `add` on one series still applies in the
      // order it was written. So does a change of `holdFor`, which the script
      // takes once per call
      const groups = grouped(
        ops,
        (op) => [op.dimKey, op.value],
        (op, first) => op.mode !== first.mode || op.holdFor !== first.holdFor,
      )

      try {
        await runScripts(
          groups.map((group) => ({
            script: group.first.mode === 'hold' ? HOLD_LEVEL : SET_LEVEL,
            // a hold is safe to run twice; a set or an add is not
            once: group.first.mode !== 'hold',
            keys: [
              key.idx(group.metric),
              key.watermark(group.metric),
              key.levels(group.metric),
              key.levelsFrom(group.metric),
              key.ownWatermark(group.metric),
            ],
            args: [
              key.bucketPrefix(group.metric),
              group.bucketTs,
              ...(group.first.mode === 'hold'
                ? []
                : [
                    group.resolutionMs,
                    group.first.mode,
                    group.integer ? 1 : 0,
                    group.first.holdFor ?? '',
                  ]),
              ...group.args,
            ],
          })),
          'setLevel',
        )
      } catch (error) {
        throw typedError(error, metricOf(error, groups))
      }
    },

    async readLevels(metric: string): Promise<LevelSeries[]> {
      const client = await connect()
      const [flat, beside] = await afterSends(() =>
        Promise.all([client.hgetall(key.levels(metric)), client.hgetall(key.levelsFrom(metric))]),
      )

      const series: LevelSeries[] = []
      // series a build between 0.7.0 and this one stored in five fields,
      // which 0.7.0 reads as absent. Every flush reads the series, so the
      // first flush after an upgrade leaves every one in four
      const fiveFields: string[] = []
      for (const [dimKey, packed] of Object.entries(flat)) {
        const parts = packed.split('|')
        const one = levelSeriesOf(dimKey, parts, beside[dimKey])
        if (one !== undefined) series.push(one)
        if (parts.length === 5) fiveFields.push(dimKey, packed)
      }
      if (fiveFields.length > 0) {
        await runScripts(
          chunks(fiveFields, 2 * MAX_PAIRS_PER_SCRIPT).map((some) => ({
            script: REWRITE_LEVELS,
            keys: [key.levels(metric), key.levelsFrom(metric)],
            args: some,
          })),
          'readLevels',
        )
      }

      return series.sort((a, b) => (a.dimKey < b.dimKey ? -1 : 1))
    },

    async readLevel(metric: string, dimKey: string): Promise<LevelSeries | undefined> {
      const client = await connect()
      // one field of the level hash, where `readLevels` fetches all of them
      const [packed, beside] = await afterSends(() =>
        Promise.all([
          client.hget(key.levels(metric), dimKey),
          client.hget(key.levelsFrom(metric), dimKey),
        ]),
      )
      return packed === null ? undefined : levelSeriesFrom(dimKey, packed, beside ?? undefined)
    },

    async sumBuckets(query: BucketRange): Promise<number | undefined> {
      const reply = await runScript(
        {
          script: SUM_COUNTS,
          keys: [key.idx(query.metric)],
          args: [
            key.bucketPrefix(query.metric),
            query.from ?? '-inf',
            query.to === undefined ? '+inf' : `(${query.to}`,
          ],
        },
        'sumBuckets',
      )
      return typeof reply === 'string' ? Number(reply) : undefined
    },

    async dropLevels(
      metric: string,
      dimKeys: readonly string[],
      writtenBefore?: number,
    ): Promise<void> {
      if (dimKeys.length === 0) return
      await runScripts(
        chunks(dimKeys, MAX_PAIRS_PER_SCRIPT).map((some) => ({
          script: DROP_LEVELS,
          keys: [key.levels(metric), key.levelsFrom(metric)],
          args: [writtenBefore === undefined ? '' : writtenBefore, ...some],
        })),
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

      // in slices, each its own script call: the records become arguments,
      // and a quarter of a million arguments overflows the stack of the call
      // that passes them. Each slice is applied once on its own
      await runScripts(
        [...byMetric].flatMap(([metric, encoded]) =>
          chunks(encoded, MAX_PAIRS_PER_SCRIPT).map((some) => ({
            script: APPEND_RECORDS,
            once: true,
            keys: [key.records(metric), key.recordSeq(metric)],
            args: some,
          })),
        ),
        'append',
      )
    },

    async readBuckets(query: BucketQuery): Promise<BucketRow[]> {
      const lower = query.from ?? '-inf'
      // half-open: `(` is Redis for an exclusive bound
      const upper = query.to === undefined ? '+inf' : `(${query.to}`

      if (query.dimKey !== undefined) {
        // one field, not the whole hash, since a metric with a million series
        // should not come over the wire to answer a question about one of
        // them. One script finds the windows and reads the field in each, so
        // `current(dims)` and every immediate send cost one round trip
        const dimKey = query.dimKey
        const reply = await runScript(
          {
            script: READ_SERIES,
            keys: [key.idx(query.metric)],
            args: [key.bucketPrefix(query.metric), lower, upper, dimKey],
          },
          'readBuckets',
        )
        const flat = (reply ?? []) as string[]
        const rows: BucketRow[] = []
        for (let i = 0; i < flat.length; i += 2) {
          rows.push({
            bucketTs: Number(flat[i]),
            dimKey,
            value: decodeCell(flat[i + 1] as string),
          })
        }
        // the index is a sorted set and the windows arrive oldest first, but
        // the order is stated here too rather than left to the script
        return rows.sort((a, b) => a.bucketTs - b.bucketTs)
      }

      const client = await connect()
      const buckets = await afterSends(() =>
        client.zrangebyscore(key.idx(query.metric), lower, upper),
      )
      if (buckets.length === 0) return []

      const hashes = await runCommands(
        buckets.map(
          (bucketTs) => (pipeline: IoredisPipeline) =>
            pipeline.hgetall(key.bucket(query.metric, bucketTs)),
        ),
        'readBuckets',
      )
      const rows: BucketRow[] = []
      buckets.forEach((bucketTs, index) => {
        const hash = (hashes[index] ?? {}) as Record<string, string>
        for (const [dimKey, raw] of Object.entries(hash)) {
          rows.push({ bucketTs: Number(bucketTs), dimKey, value: decodeCell(raw) })
        }
      })

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
        return (await afterSends(() => client.lrange(listKey, 0, stop))).map(decodeRecord)
      }

      // bounded: paged rather than one LRANGE of everything, so a backlog the
      // query will mostly reject never crosses the wire whole. Each page
      // starts after the last record read, which READ_PAGE finds again when
      // another process has claimed or released in between
      const matched: StagedRecord[] = []
      const page = maxPipeline
      let last = ''
      let lastAt = 0
      // the newest stamp read so far. The list is in stamp order, so a
      // record at or below it after a restart was read already: a release
      // put it back at the front
      let seenUpTo = ''

      for (;;) {
        const reply = await runScript(
          { script: READ_PAGE, keys: [listKey], args: [last, lastAt, page] },
          'readPending',
        )
        const [start, restarted, fetched] = reply as [number, number, string[]]
        const raw = fetched.filter((one) => {
          const stamp = stampOf(one)
          if (stamp === '') return !restarted
          if (stamp <= seenUpTo) return false
          seenUpTo = stamp
          return true
        })
        if (fetched.length > 0) {
          last = fetched.at(-1) as string
          lastAt = Number(start) + fetched.length - 1
        }

        for (const encoded of raw) {
          const record = decodeRecord(encoded)
          if (query.from !== undefined && record.ts < query.from) continue
          if (query.to !== undefined && record.ts >= query.to) continue
          matched.push(record)
          if (query.limit !== undefined && matched.length >= query.limit) return matched
        }
        if (fetched.length < page) break
      }
      return matched
    },

    async countPending(metric: string): Promise<number> {
      // LLEN, not an LRANGE the caller counts, and the whole reason this is a
      // method of its own. Plus the in-flight lists, which are few
      const count = await runScript(
        {
          script: COUNT_PENDING,
          keys: [key.records(metric), key.claims(metric)],
          args: [key.inflight('')],
        },
        'countPending',
      )
      return Number(count ?? 0)
    },

    async landing(metric: string, bucketTs: number, resolutionMs: number): Promise<number> {
      const reply = await runScript(
        {
          script: LANDING,
          keys: [key.watermark(metric), key.ownWatermark(metric), key.idx(metric)],
          args: [bucketTs, resolutionMs],
        },
        'landing',
      )
      return Number(reply)
    },

    async claim(metric: string, upToBucketTs: number, aheadFrom?: number): Promise<BucketClaim> {
      // refused before the script, which would store it as the watermark: a
      // watermark of NaN compares false against every window, and no late
      // write would move forward past a claimed one again
      if (!Number.isFinite(upToBucketTs)) {
        throw new Error(
          `ioredis driver: ${metric} cannot be claimed up to ${upToBucketTs}, which is not a ` +
            'finite number',
        )
      }
      const id = nextClaimId(metric)

      // stamped by Redis, inside the script: the score in the claims ZSET is
      // what decides whether this claim is stale, and a stamp from this
      // host's clock would be compared later against another host's
      const { claimedAt, taken } = claimReply(
        await runScript(
          {
            script: CLAIM_BUCKETS,
            keys: [
              key.idx(metric),
              key.inflight(id),
              key.claims(metric),
              key.watermark(metric),
              key.ownWatermark(metric),
            ],
            args: [upToBucketTs, id, key.bucketPrefix(metric), aheadFrom ?? ''],
          },
          'claim',
        ),
      )

      return { kind: 'buckets', id, metric, claimedAt, buckets: unflatten(taken) }
    },

    async claimRecords(metric: string, limit?: number): Promise<RecordClaim> {
      const id = nextClaimId(metric)

      const { claimedAt, taken } = claimReply(
        await runScript(
          {
            script: CLAIM_RECORDS,
            once: true,
            keys: [key.records(metric), key.inflight(id), key.claims(metric)],
            args: [limit === undefined ? -1 : Math.max(0, limit), id],
          },
          'claimRecords',
        ),
      )

      return { kind: 'records', id, metric, claimedAt, records: taken.map(decodeRecord) }
    },

    async ack(claim: Claim): Promise<void> {
      const settled = await runScript(
        {
          script: ACK_CLAIM,
          once: true,
          keys: [key.claims(claim.metric), key.inflight(claim.id)],
          args: [claim.id],
        },
        'ack',
      )
      assertSettled(settled, claim)
    },

    async release(claim: Claim): Promise<void> {
      const call: ScriptCall = isRecordClaim(claim)
        ? {
            script: RELEASE_RECORDS,
            once: true,
            keys: [key.records(claim.metric), key.inflight(claim.id), key.claims(claim.metric)],
            args: [claim.id],
          }
        : {
            script: RELEASE_BUCKETS,
            once: true,
            keys: [key.claims(claim.metric), key.inflight(claim.id), key.idx(claim.metric)],
            args: [claim.id, key.bucketPrefix(claim.metric)],
          }

      let settled: unknown
      try {
        settled = await runScript(call, 'release')
      } catch (error) {
        throw typedError(error, claim.metric)
      }
      assertSettled(settled, claim)
    },

    async recover(metric: string): Promise<RecoveryReport> {
      // the cutoff is worked out inside the script from Redis's clock, the
      // same clock `claim` stamped the registry with, so "older than the
      // cutoff" never compares two machines' ideas of now

      let raw: unknown
      try {
        raw = await runScript(
          {
            script: RECOVER_CLAIMS,
            once: true,
            keys: [key.claims(metric), key.idx(metric), key.records(metric)],
            // `inflight('')` rather than a literal, so the prefix cannot
            // drift from the key the claim was actually written to
            args: [recoverAfterMs, key.inflight(''), key.bucketPrefix(metric)],
          },
          'recover',
        )
      } catch (error) {
        throw typedError(error, metric)
      }

      const [claims = 0, buckets = 0, records = 0, oldest = 0] = (raw ?? []) as number[]
      if (claims === 0) return NOTHING_RECOVERED

      return { claims, buckets, records, ...(oldest > 0 && { oldestClaimedAt: oldest }) }
    },

    async takeTurn(metric: string, now: number, gapMs: number): Promise<ShipTurn> {
      const token = uuidv7(Date.now())
      const reply = await runScript(
        {
          script: TAKE_TURN,
          once: true,
          keys: [key.turn(metric), key.turnToken(metric)],
          args: [now, gapMs, token],
        },
        'takeTurn',
      )
      const [granted, last] = reply as [number, string]
      const previous = turnFrom(last)
      if (granted === 1) return { granted: true, turn: { at: now, token }, previous }
      return { granted: false, lastTakenAt: previous?.at as number }
    },

    async returnTurn(metric: string, turn: Turn, previous: Turn | undefined): Promise<void> {
      await runScript(
        {
          script: RETURN_TURN,
          once: true,
          keys: [key.turn(metric), key.turnToken(metric)],
          args: [turn.at, turn.token, previous?.at ?? '', previous?.token ?? ''],
        },
        'returnTurn',
      )
    },
  }
}
