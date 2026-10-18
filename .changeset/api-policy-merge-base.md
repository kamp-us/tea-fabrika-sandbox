---
"@demlik/code-graph": patch
---

`--api-policy` (and `readChangesetsSince`) now counts a changeset only when the working tree has it and the tree of the merge base of `<rev>` and `HEAD` does not, instead of the base commit's tree. A branch that is behind its base no longer counts the changesets the base has since released and deleted, so a released `major` with the callout can no longer cover a new breaking change. An up-to-date branch or a merge-ref checkout with `HEAD^1` counts the same files as before. When git finds no merge base (a shallow clone, unrelated histories), the run exits 2 naming the rev and saying to fetch more history, and never falls back to the base commit's tree.
