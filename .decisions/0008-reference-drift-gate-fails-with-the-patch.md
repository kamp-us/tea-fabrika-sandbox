---
id: 0008
title: The reference drift gate fails with the patch, single-sourced
status: accepted
date: 2026-07-17
tags: []
---

# 0008 — The reference drift gate fails with the patch, single-sourced

**Scope:** packages/tea (reference drift gate, CI)

**Amended in part by the tea docs sweep (#548):** `docs:reference:check` now runs
a stray-file step first, and one suite test reads the committed `docs/reference/`
directory. Decision points 1 and 2 stand as amended — see
[Amendments](#amendments).

## Context

ADR 0007 committed the generated reference (`packages/tea/docs/reference/`) to
the repo and gated it so a public-API change that skipped regeneration fails CI.
The reference is a *projection* of source — a new export, a reworded TSDoc line,
or a changeset version bump all change what the generator emits — so on a
fast-moving library the gate fires often, on ordinary source PRs.

The first cut of that gate had two problems. It was drift-checked **twice**: a
vitest `it("committed pages match …")` assertion inside the normal test run, and
a separate CI step that re-ran the same test. Both only printed **filenames** —
`Reference docs are out of date (do.md, index.md)` — with no indication of *what*
diverged, and the vitest copy fired during `Run tests`, before the dedicated
step, so the author never reached even that message. During this ADR's own
rollout the gate caught a real stale-docs drift (PR #297) but could only name the
files; the fix — *which* line, *why* — had to be reverse-engineered by hand.

## Decision

1. **One gate, and it fails with the patch.** `docs:reference:check` is now
   `pnpm run docs:reference && git diff --exit-code -- docs/reference`: it
   regenerates the pages from the live source, then `git diff --exit-code`
   **prints the exact unified diff and exits non-zero**. The failure output *is*
   the fix — the author reads the patch, runs `pnpm --filter @demlik/tea
   docs:reference`, and commits. No filenames-only guessing. *(Amended by #548:
   a stray-file step now runs first — see [Amendments](#amendments).)*

2. **Single-sourced (one concern, one gate).** The committed-match assertion is
   removed from the vitest suite. Vitest keeps only the *mechanism* proofs — the
   guard fires when a page is tampered, every curated subpath is a real
   `package.json` export, page filenames are unique. Whether the *committed*
   pages match source is owned solely by `docs:reference:check`. *(Amended by
   #548: one named suite test reads the committed directory for extra files —
   see [Amendments](#amendments).)*

3. **Runs before `Run tests`.** The CI step sits right after Lint, so the patch
   surfaces before any coarser failure can mask it.

4. **Source-only, no build dependency.** The generator reads the typedoc model
   over `src/`, not the tsup `dist/` — verified by regenerating with `dist`
   removed — so the gate runs early and cheaply, before `Build`.

## Rejected alternatives

- **CI auto-regenerates and commits back (a bot).** The repo already runs a
  commit-back bot (changesets' release PR), so the pattern and permissions exist.
  Rejected *for now*: for a two-person repo it adds token + loop-guard machinery
  to save a single command, and a push made with the default `GITHUB_TOKEN` does
  not re-trigger CI (needing a PAT). Fail-with-patch keeps the human in the loop
  at near-zero cost. Revisit if the contributor count grows — this is the escape
  hatch if the per-PR regeneration friction ever bites.

- **A local git hook (husky / lefthook).** The repo has no hook infrastructure at
  all. A hook is per-clone, skippable with `--no-verify`, and a forgotten install
  silently re-reds CI. Introducing a hook system to solve a one-command problem is
  machinery for its own sake.

## Deferred debts (the dogfood loop's findings)

- The gate re-fires on **every** PR that moves tea's public source. That is
  correct — the docs track the source — but it means a source change and its
  reference regeneration ride together; authors regenerate before pushing.
- A source PR that lands **between** a docs-touching branch's regeneration and its
  merge will stale that branch. This bit PR #297 twice during its own rollout.
  Mitigation is discipline, not tooling: merge docs-affecting tea PRs promptly.
  If it recurs often, the rejected auto-commit-back bot is the standing answer.

## Consequences

- A stale reference can never merge, and the failure names exactly what changed
  and how to fix it in one line — no reverse-engineering.
- Zero standing maintenance machinery: no bot, no hook, no extra token.
- The reference stays committed and browsable in-repo and on GitHub.
- The cost is one command (`docs:reference`) whenever a contributor changes tea's
  public surface — a cost that scales with how often the public API churns.

## Amendments

- **#548 — decision points 1 and 2: the gate gains a stray-file step, and one
  suite test reads the committed directory. Landed in the tea docs sweep,
  https://github.com/kamp-us/demlik/pull/553.**

  `docs:reference:check` (`packages/tea/package.json`) now runs three steps, in
  this order:

  ```
  pnpm run docs:reference:strays && pnpm run docs:reference && git diff --exit-code -- docs/reference
  ```

  1. `pnpm run docs:reference:strays` — `vitest run
     src/docs/reference/generate-reference.test.ts -t 'holds nothing the
     generator does not write'`: fails if `docs/reference/` holds any file the
     generator does not write.
  2. `pnpm run docs:reference` — regenerates the pages from the live source.
  3. `git diff --exit-code -- docs/reference` — prints the patch and exits
     non-zero on drift, as decision point 1 describes.

  **Why the stray step exists.** `git diff --exit-code` only sees tracked
  files. An untracked page in `docs/reference/` — for example one left behind
  after an export was removed — produced no diff, so it slipped past the
  two-step gate.

  **Why it runs first.** The writer (`docs:reference`) deletes strays when it
  regenerates, so after step 2 there is nothing left to find. The stray check
  must run before regeneration to see the committed directory as it is.

  **Decision point 2's one named exception.** The test
  `docs/reference/ holds nothing the generator does not write` in
  `packages/tea/src/docs/reference/generate-reference.test.ts` is the one suite
  test that reads the real committed `docs/reference/` directory, and it runs in
  the normal test run as well as in step 1. It checks for extra files only.
  Whether the committed page *content* matches source is still owned by
  `docs:reference:check` alone. Do not delete this test: without it, a stray
  page reopens the gap the stray step closes.
