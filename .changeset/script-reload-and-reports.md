---
"metrichouse": patch
---

Fix what a script reload lets through, and what an event stops reporting.

- The Redis driver loads all of its scripts together, as one set, so after a restart or a `SCRIPT FLUSH` Redis refuses every script call the driver sends until the set is loaded again. A call made while the refusal of an earlier call was still on its way back used to run ahead of that call's resend when its own script had been loaded since the flush, so a claim could miss a write made before it.
- The Redis driver runs a plain read again once a resend has gone, when Redis refused a round trip sent before the read. `readBuckets` and the other reads used to miss a write made before them while Redis was refusing it.
- An event staged in the driver forgets a reported unreadable record once a read of the whole staged list no longer finds it. Records another process shipped used to stay remembered for good, and once 10,000 of them had piled up no unreadable record was reported again.
- Docs: a `flush()` you call returns only its recovery pass's failure as `recoveryError`. A failure while it claims from the driver, or while it gives back a late claim, goes to `onError`, or is dropped when there is none.
