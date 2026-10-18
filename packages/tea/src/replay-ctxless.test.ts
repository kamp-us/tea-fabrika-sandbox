/**
 * `replay()` — a pure machine needs no `ctx`.
 *
 * `replay`'s options take `ctx` through `CtxArg<Ctx>`, as `run`'s do: a machine
 * whose `Ctx` is satisfiable by the empty object replays with no `ctx`, and the
 * omitted `ctx` reaches `init` as `{}`. This is the RUNTIME half; the
 * compile-time half lives in `__tests__/replay-ctxless.test-d.ts`.
 */

import { describe, expect, it } from "vitest";
import { defineMachine, type NoCtx, type Reducer, replay } from "./index";
import { expectFinalState } from "./testing";

type State = { readonly count: number };
type Msg = { readonly type: "bump" } | { readonly type: "reset" };

function pureMachine(seen: unknown[] = []) {
  const update: Reducer<State, Msg, never> = {
    bump: (s) => [{ count: s.count + 1 }, []],
    reset: () => [{ count: 0 }, []],
  };
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: {} as NoCtx },
    init: (_loaded, ctx) => {
      seen.push(ctx);
      return [{ count: 0 }, []];
    },
    update,
  });
}

describe("replay() — pure machine, no ctx", () => {
  it("folds three different message lists to their expected final states", () => {
    const machine = pureMachine();
    const cases: [readonly Msg[], number][] = [
      [[], 0],
      [[{ type: "bump" }, { type: "bump" }, { type: "bump" }], 3],
      [[{ type: "bump" }, { type: "reset" }, { type: "bump" }], 1],
    ];
    for (const [msgs, count] of cases) {
      expect(replay(machine, { msgs }).state).toEqual({ count });
      expectFinalState(machine, { msgs }, { count });
    }
  });

  it("hands `init` an empty `{}` when ctx is omitted, as `run` does", () => {
    const seen: unknown[] = [];
    replay(pureMachine(seen), { msgs: [] });
    expect(seen).toEqual([{}]);
  });
});
