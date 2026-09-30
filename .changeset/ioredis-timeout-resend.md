---
'metrichouse': patch
---

`ioredis()` no longer applies a write twice when the client has a
`commandTimeout`. A write that timed out, or whose connection closed before
Redis answered, stopped being tracked at once, so the next write let Redis
forget it had applied it. ioredis still resends such a write after a reconnect,
and the resend then counted again: three `add(1)` calls could leave a counter
at 4. Such a write is now tracked until a write sent after it has been answered.
