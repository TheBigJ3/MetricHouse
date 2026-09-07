-- Breadcrumb plating. All of this is derivable, which is why none of it is
-- in MetricHouse.

-- Funnel conversion by variant
SELECT variant,
       sumIf(value, step = 'started')   AS started,
       sumIf(value, step = 'completed') AS completed,
       sumIf(value, step = 'completed') / sumIf(value, step = 'started') AS rate
FROM funnel FINAL
WHERE flow = 'signup' AND bucket_ts >= now() - INTERVAL 7 DAY
GROUP BY variant;

-- Revenue per visitor, the A/B decision number
SELECT r.variant, sum(r.value) / s.sessions AS rpv
FROM revenue FINAL r
JOIN (SELECT variant, uniq(sessionId) AS sessions FROM track
      WHERE ts >= now() - INTERVAL 7 DAY GROUP BY variant) s USING (variant)
WHERE r.bucket_ts >= now() - INTERVAL 7 DAY
GROUP BY r.variant, s.sessions;

-- Sessionization — raw events, never MetricHouse's job
SELECT sessionId, min(ts) AS started, max(ts) AS ended,
       count() AS steps, groupArray(name) AS path
FROM track WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY sessionId HAVING steps > 1;

-- Client clock skew, answerable because _ingested_at is reserved (Coldchain C02)
SELECT quantiles(0.5, 0.95, 0.99)(_ingested_at - toDateTime64(clientTs / 1000, 3))
FROM track WHERE ts >= now() - INTERVAL 1 DAY;

-- Live uniques per variant come from distinct(), not from here
