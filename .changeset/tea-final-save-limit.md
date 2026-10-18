---
"@demlik/tea": patch
---

`stop()` no longer hangs when the store's final `save()` never returns. The final save now runs under `disposeTimeoutMs`, the same limit as `stop()`'s wait for the queue and for async teardown. When that limit runs out, `stop()` reports a new `FinalSaveTimeoutNotice` (carrying `timeoutMs`) to `onError` under `phase: "stop-save"` and returns. That covers both engines, and closing an Effect run's Scope too. `stop()` now makes three waits, each up to the limit, so the worst case is three times `disposeTimeoutMs`. A final save that finishes inside the limit, or that rejects, behaves as it did before.
