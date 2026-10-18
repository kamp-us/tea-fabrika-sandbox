// Type-level test for `replay()`'s conditionally-optional `ctx`, and for the
// `@demlik/tea/testing` helpers that take the same options (`ReplayOpts`).
// Compiled by `pnpm typecheck` like its sibling `run-ctxless.test-d.ts`: each
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check, and
// every line without one is a positive case that must compile.
//
// The contract (`CtxArg<Ctx>`, the same rule `run` uses): a machine whose `Ctx`
// is satisfiable by the empty object replays with `ctx` OMITTED; a machine
// whose `Ctx` carries a field `init` reads keeps `ctx` REQUIRED.

import { defineMachine, type NoCtx, type Reducer, replay } from "../index";
import {
  expectCmdEmitted,
  expectFinalState,
  expectReplayDeterministic,
} from "../testing";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };

const pureUpdate: Reducer<State, Msg, never> = {
  bump: (s) => [{ count: s.count + 1 }, []],
};

// A PURE machine: Ctx = NoCtx (reads nothing from ctx).
function pureMachine() {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: {} as NoCtx },
    init: () => [{ count: 0 }, []],
    update: pureUpdate,
  });
}

// A CONTEXT-BEARING machine: Ctx has a field `init` reads.
type DbCtx = { readonly db: { readonly read: () => number } };
function dbMachine() {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: {} as DbCtx },
    init: (_loaded, ctx) => [{ count: ctx.db.read() }, []],
    update: pureUpdate,
  });
}

const msgs: Msg[] = [{ type: "bump" }];
const db = { db: { read: () => 1 } };

// ── POSITIVE: a pure machine replays with NO ctx ────────────────────────────
replay(pureMachine(), { msgs });
expectFinalState(pureMachine(), { msgs }, { count: 1 });
expectCmdEmitted(pureMachine(), { msgs }, {} as never);
expectReplayDeterministic(pureMachine(), { msgs });

// ── POSITIVE: an explicit ctx still compiles (additive) ─────────────────────
replay(pureMachine(), { msgs, ctx: {} });
expectFinalState(pureMachine(), { msgs, ctx: {} }, { count: 1 });

// ── NEGATIVE: a context-bearing machine still REQUIRES ctx ──────────────────
// @ts-expect-error DbCtx is not satisfiable by {} (ctx required)
replay(dbMachine(), { msgs });
// @ts-expect-error DbCtx is not satisfiable by {} (ctx required)
expectFinalState(dbMachine(), { msgs }, { count: 2 });

// ── POSITIVE: providing the required ctx compiles ───────────────────────────
replay(dbMachine(), { msgs, ctx: db });
expectFinalState(dbMachine(), { msgs, ctx: db }, { count: 2 });
