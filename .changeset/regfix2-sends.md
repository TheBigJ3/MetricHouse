---
"metrichouse": patch
---

Fix how sends wait for one another.

- A flush under immediate delivery waits for an immediate send only until one flush interval after that send started, and never waits again for a send an earlier flush gave up on. A `write` function that never answered one immediate send used to hold up every later flush of the metric by a full interval, so a metric on the scheduler shipped only every other interval.
- The Redis driver keeps one writer's writes in order when Redis forgets its scripts. After the first NOSCRIPT refusal it issues nothing new until every round trip already sent is answered, then sends every refused call again in the order the calls were made. A call made between two refusals used to land ahead of the second one's resend, so a level set or gauge could end on the older value.
- Docs: `drain()` and `house.stop()` wait for an immediate send already under way with no limit, so a `write` function needs a timeout of its own.
