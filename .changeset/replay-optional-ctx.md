---
"@demlik/tea": minor
---

`replay` now takes `ctx` through `CtxArg<Ctx>`, the same rule `run` uses: a pure machine (one whose `Ctx` is satisfiable by `{}`) can call `replay(machine, { msgs })` with no `ctx`, and the omitted `ctx` reaches `init` as `{}`. `ReplayOpts` in `@demlik/tea/testing` takes `ctx` the same way, so `expectFinalState`, `expectCmdEmitted`, `expectCmdSequence`, `expectActiveSubs` and `expectReplayDeterministic` accept a pure machine with no `ctx`. A machine whose `Ctx` has required fields still has to pass `ctx`, and every existing `replay(m, { msgs, ctx })` call keeps compiling.

**Breaking (types only, stable tier):** `ReplayOpts` in `@demlik/tea/testing` is now a type alias instead of an interface, so an `interface X extends ReplayOpts<…>` or a declaration merge into it no longer compiles; write `type X = ReplayOpts<…> & { … }` instead. Code that reads `.ctx` off a `replay` options value or a `ReplayOpts` whose `Ctx` is still generic now sees `ctx` as optional (`Ctx | undefined`), so default it as `replay` does (`opts.ctx ?? {}`). Every call site that passes `ctx` is unaffected.
