-- Coldchain plating. The 7-year retention story lives here because the DDL
-- generator has no rollup opinion (FLAW C05).

-- Compliance: minutes outside range, per container, per voyage
SELECT containerId, threshold, sum(value) / 60000 AS minutes
FROM excursion_ms FINAL
WHERE bucket_ts BETWEEN '2026-08-01' AND '2026-09-01'
GROUP BY containerId, threshold
HAVING minutes > 30;

-- Door-open level reconstructed from deltas, carry-forward included
SELECT bucket_ts,
       sum(sum(delta)) OVER (PARTITION BY containerId ORDER BY bucket_ts) AS doors
FROM doors_open FINAL
WHERE containerId = 'MSCU7841203'
GROUP BY bucket_ts, containerId;

-- Temperature band, gauge aggregates merging correctly across any window
SELECT toStartOfHour(bucket_ts) AS h, containerId,
       min(min) AS lo, max(max) AS hi, sum(sum) / sum(count) AS mean
FROM temp_c FINAL
WHERE bucket_ts >= now() - INTERVAL 7 DAY
GROUP BY h, containerId;

-- Ingest lag — the health signal MetricHouse cannot provide (FLAW C09)
SELECT containerId, max(ingestedTs - deviceTs) / 1000 AS worst_lag_s,
       (now() - max(toDateTime(ingestedTs / 1000))) AS silent_for
FROM reading
WHERE ts >= now() - INTERVAL 2 HOUR
GROUP BY containerId
HAVING silent_for > 1800;

-- Backfill audit: which rows arrived late, and by how much (FLAW C02)
-- Only answerable because schema.ts hand-declared deviceTs/ingestedTs.
SELECT toStartOfDay(toDateTime(deviceTs / 1000)) AS measured_day,
       count(), avg(ingestedTs - deviceTs) / 3600000 AS avg_delay_hours
FROM reading
WHERE ingestedTs - deviceTs > 3600000
GROUP BY measured_day ORDER BY measured_day DESC;

-- The rollup the DDL generator should have emitted (FLAW C05).
-- Hand-written, hand-scheduled, and the thing that makes 7 years affordable.
ALTER TABLE temp_c
  MODIFY TTL bucket_ts + INTERVAL 7 DAY
    GROUP BY fleet, region, containerId, sensor, toStartOfHour(bucket_ts)
    SET min = min(min), max = max(max), sum = sum(sum), count = sum(count),
  bucket_ts + INTERVAL 7 YEAR DELETE;
