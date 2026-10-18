---
"@demlik/tea": patch
---

The reference entry for `DefineAgentCompaction` now shows `afterTurns`, `afterContextTokens` and `keepTurns`, each with its description. It used to print `CompactionTriggers & { … }`, naming a private type that has no reference entry, and `keepTurns` did not appear at all. The type accepts the same values as before: at least one of `afterTurns` / `afterContextTokens` is required and `keepTurns` is optional. No new export.
