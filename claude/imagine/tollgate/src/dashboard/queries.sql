-- The plating. Everything MetricHouse refuses to compute, computed here.
-- These all work, and they are the argument that dropping histograms was right.

-- p50 / p95 / p99 latency by model, last hour
SELECT model,
       quantile(0.50)(latencyMs) AS p50,
       quantile(0.95)(latencyMs) AS p95,
       quantile(0.99)(latencyMs) AS p99
FROM request_completed
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY model ORDER BY p95 DESC;

-- a real histogram, bucketed however you like today
SELECT model, floor(latencyMs / 250) * 250 AS bucket, count()
FROM request_completed
WHERE ts >= now() - INTERVAL 1 HOUR
GROUP BY model, bucket ORDER BY model, bucket;

-- per-second fidelity, rolled up to whatever window the panel asks for
-- (this is the payoff for resolution being independent of flush)
SELECT toStartOfInterval(bucket_ts, INTERVAL 1 MINUTE) AS w,
       tenantId, sum(value) AS reqs
FROM requests FINAL
WHERE bucket_ts >= now() - INTERVAL 6 HOUR
GROUP BY w, tenantId;

-- error rate, from counters, unsampled and exact
SELECT toStartOfMinute(bucket_ts) AS m,
       sumIf(value, status != 'ok') / sum(value) AS error_rate
FROM requests FINAL
WHERE bucket_ts >= now() - INTERVAL 1 HOUR
GROUP BY m;

-- gauge average, derived correctly across any window (sum/count merges, avg does not)
SELECT toStartOfHour(bucket_ts) AS h, model,
       sum(sum) / sum(count) AS avg_ttft_ms,
       max(max)              AS worst_ttft_ms
FROM ttft_ms FINAL
WHERE bucket_ts >= now() - INTERVAL 24 HOUR
GROUP BY h, model;

-- cost per tenant, with the micro-dollar unit leak on display
SELECT tenantId, sum(value) / 1e6 AS usd
FROM cost_micro_usd FINAL
WHERE toYYYYMM(bucket_ts) = '202609'
GROUP BY tenantId ORDER BY usd DESC LIMIT 20;
