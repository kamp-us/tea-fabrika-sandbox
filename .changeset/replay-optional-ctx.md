---
"@demlik/tea": minor
---

`replay` now takes `ctx` through `CtxArg<Ctx>`, the same rule `run` uses: a pure machine (one whose `Ctx` is satisfiable by `{}`) can call `replay(machine, { msgs })` with no `ctx`, and the omitted `ctx` reaches `init` as `{}`. `ReplayOpts` in `@demlik/tea/testing` takes `ctx` the same way, so `expectFinalState`, `expectCmdEmitted`, `expectCmdSequence`, `expectActiveSubs` and `expectReplayDeterministic` accept a pure machine with no `ctx`. A machine whose `Ctx` has required fields still has to pass `ctx`, and every existing `replay(m, { msgs, ctx })` call keeps compiling. `ReplayOpts` is now a type alias instead of an interface.
