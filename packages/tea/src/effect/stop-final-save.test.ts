/**
 * `stop()`'s final save gets the same limit as its other two waits (ADR 0025,
 * #670). A store whose `save()` never returns cannot keep `stop()` from
 * returning: at `disposeTimeoutMs` it gives up on the save, reports a
 * `FinalSaveTimeoutNotice` under `"stop-save"` and returns. A save inside the
 * limit lands and reports nothing; a save that rejects is reported under
 * `"stop-save"` as before.
 *
 * Both engines run one loop, so every case runs on both, and on the Effect
 * engine closing the run's Scope stands in for `stop()` too. It lives under
 * `src/effect/` because it imports `effect`, which only this entry may do.
 */

import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  DisposeTimeoutNotice,
  DrainTimeoutNotice,
  defineMachine,
  FinalSaveTimeoutNotice,
  type NoCtx,
  type RuntimeErrorContext,
  type Store,
  type Sub,
} from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { run as runEffect, StoreFailed } from "./index";

type Model = { readonly asked: number };
type Msg = { readonly type: "ask" };
type Cmd = { readonly type: "warm" } | { readonly type: "work" };
type Feed = Sub<"feed", { readonly gen: number }>;

// A step that went on after `stop()` would start a `work` handler and a fresh
// Sub (its id follows `asked`), so the probe can see it.
const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Cmd,
    sub: {} as Feed,
    ctx: {} as NoCtx,
  },
  init: (loaded) => [loaded ?? { asked: 0 }, [{ type: "warm" }]],
  update: {
    ask: (s) => [{ asked: s.asked + 1 }, [{ type: "work" }]],
  },
  subs: [{ type: "feed", deps: (s: Model) => ({ gen: s.asked }) }],
});

const LIMIT_MS = 50;
/** Each `stop()` returns within this, where it used to never return. */
const RETURNS_WITHIN_MS = 250;

const ENGINES = ["Promise", "Effect"] as const;
type Engine = (typeof ENGINES)[number];

/** How the host lets go of the run: `stop()`, or closing the run's Scope. */
const WAYS = ["stop", "close"] as const;
type Way = (typeof WAYS)[number];

interface Probe {
  readonly reports: { error: unknown; phase: string }[];
  readonly handlers: string[];
  subs: number;
}

interface Started {
  readonly probe: Probe;
  ready(): Promise<unknown>;
  dispatch(msg: Msg): Promise<void>;
  /** Let go of the run the way the case names. */
  letGo(way: Way): Promise<void>;
}

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const start: Record<Engine, (store: Store<Model>) => Promise<Started>> = {
  Promise: async (store) => {
    const probe: Probe = { reports: [], handlers: [], subs: 0 };
    const booting = runPromise(machine, {
      store,
      disposeTimeoutMs: LIMIT_MS,
      onError: (error: unknown, context: RuntimeErrorContext) => {
        probe.reports.push({ error, phase: context.phase });
      },
      interpret: {
        warm: async () => {
          probe.handlers.push("warm");
        },
        work: async () => {
          probe.handlers.push("work");
        },
      },
      subscribe: {
        feed: () => {
          probe.subs++;
          return () => {};
        },
      },
    });
    return {
      probe,
      ready: () => booting.ready,
      dispatch: async (msg) => (await booting.ready).dispatchOnce(msg),
      // The Promise engine has no Scope: a host only has `stop()`.
      letGo: () => booting.stop(),
    };
  },
  Effect: async (store) => {
    const probe: Probe = { reports: [], handlers: [], subs: 0 };
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          store,
          disposeTimeoutMs: LIMIT_MS,
          onError: (error: unknown, context: RuntimeErrorContext) => {
            probe.reports.push({ error, phase: context.phase });
          },
          interpret: {
            warm: () =>
              Effect.sync(() => {
                probe.handlers.push("warm");
              }),
            work: () =>
              Effect.sync(() => {
                probe.handlers.push("work");
              }),
          },
          subscribe: {
            feed: () => {
              probe.subs++;
              return Stream.never;
            },
          },
        }),
      ),
    );
    return {
      probe,
      ready: () => settle(booting.ready),
      dispatch: (msg) =>
        settle(Effect.flatMap(booting.ready, (rt) => rt.dispatchOnce(msg))),
      letGo: (way) =>
        way === "stop"
          ? Effect.runPromise(booting.stop())
          : Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  },
};

/** A promise the test holds and releases. */
function hold(): { readonly released: Promise<void>; release(): void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

/**
 * A memory store whose `save()` stops answering once `stopAnswering()` is
 * called: every save from then on is held until `release()`.
 */
function deadStore() {
  const inner = memoryStore<Model>(null);
  const held = hold();
  const saves: Model[] = [];
  let answering = true;
  const store: Store<Model> = {
    ...inner,
    async save(state) {
      saves.push(state);
      if (!answering) await held.released;
      await inner.save(state);
    },
  };
  return {
    store,
    inner,
    saves,
    stopAnswering: () => {
      answering = false;
    },
    release: held.release,
  };
}

/** Long enough for any store call a released run would start to be recorded. */
const settleLateWork = () => new Promise((resolve) => setTimeout(resolve, 30));

async function until(holds: () => boolean): Promise<void> {
  while (!holds()) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** Let go of each run side by side; the time each took to return. */
async function timeLetGo(runs: readonly Started[], way: Way) {
  return Promise.all(
    runs.map(async (run) => {
      const began = performance.now();
      await run.letGo(way);
      return performance.now() - began;
    }),
  );
}

/** The Effect engine's wrapper off a save failure, so both engines read alike. */
const saveFailureOf = (error: unknown): unknown =>
  error instanceof StoreFailed ? error.cause : error;

const cases = ENGINES.flatMap((engine) =>
  WAYS.filter((way) => engine === "Effect" || way === "stop").map(
    (way) => [engine, way] as const,
  ),
);

describe.each(
  cases,
)("%s engine, host lets go by %s: the final save has a limit", (engine, way) => {
  it("three runs whose store stops answering at stop() each return, with one report for the save given up on", async () => {
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const dead = deadStore();
        const run = await start[engine](dead.store);
        await run.ready();
        await run.dispatch({ type: "ask" });
        return { run, ...dead };
      }),
    );
    for (const r of runs) {
      expect(r.saves).toEqual([{ asked: 0 }, { asked: 1 }]);
      r.stopAnswering();
    }

    const elapsed = await timeLetGo(
      runs.map((r) => r.run),
      way,
    );

    for (const [i, r] of runs.entries()) {
      expect(elapsed[i]).toBeGreaterThanOrEqual(LIMIT_MS - 5);
      expect(elapsed[i]).toBeLessThan(RETURNS_WITHIN_MS);
      // The final save was started, once.
      expect(r.saves).toEqual([{ asked: 0 }, { asked: 1 }, { asked: 1 }]);
      expect(r.run.probe.reports).toEqual([
        { error: expect.any(FinalSaveTimeoutNotice), phase: "stop-save" },
      ]);
      const notice = r.run.probe.reports[0]?.error;
      expect(notice).not.toBeInstanceOf(DrainTimeoutNotice);
      expect(notice).not.toBeInstanceOf(DisposeTimeoutNotice);
      expect((notice as FinalSaveTimeoutNotice).timeoutMs).toBe(LIMIT_MS);
    }

    // The held save is released: it lands, and nothing new starts.
    for (const r of runs) r.release();
    await settleLateWork();
    await Promise.all(runs.map((r) => r.run.letGo(way)));
    await settleLateWork();
    for (const r of runs) {
      expect(r.saves).toHaveLength(3);
      expect(await r.inner.load()).toEqual({ asked: 1 });
      expect(r.run.probe.handlers).toEqual(["warm", "work"]);
      expect(r.run.probe.subs).toBe(2);
      expect(r.run.probe.reports).toHaveLength(1);
    }
  });

  it("three runs whose store stopped answering during a step report the drain and the final save, and return", async () => {
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const dead = deadStore();
        const run = await start[engine](dead.store);
        await run.ready();
        dead.stopAnswering();
        const asked = run.dispatch({ type: "ask" }).then(
          () => undefined,
          (error: unknown) => error,
        );
        await until(() => dead.saves.length === 2);
        return { run, asked, ...dead };
      }),
    );

    const elapsed = await timeLetGo(
      runs.map((r) => r.run),
      way,
    );

    for (const [i, r] of runs.entries()) {
      expect(elapsed[i]).toBeLessThan(RETURNS_WITHIN_MS);
      // Boot's save, the step's held save, and stop()'s final save.
      expect(r.saves).toEqual([{ asked: 0 }, { asked: 1 }, { asked: 1 }]);
      expect(r.run.probe.reports).toEqual([
        { error: expect.any(DrainTimeoutNotice), phase: "discard" },
        { error: expect.any(FinalSaveTimeoutNotice), phase: "stop-save" },
      ]);
      expect(
        (r.run.probe.reports[1]?.error as FinalSaveTimeoutNotice).timeoutMs,
      ).toBe(LIMIT_MS);
    }

    // Both held saves are released: no save, Sub or handler starts after.
    for (const r of runs) r.release();
    expect(await Promise.all(runs.map((r) => r.asked))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await settleLateWork();
    await Promise.all(runs.map((r) => r.run.letGo(way)));
    await settleLateWork();
    for (const r of runs) {
      expect(r.saves).toHaveLength(3);
      expect(r.run.probe.handlers).toEqual(["warm"]);
      expect(r.run.probe.subs).toBe(1);
      expect(r.run.probe.reports).toHaveLength(2);
    }
  });

  it("a final save inside the limit lands and reports nothing", async () => {
    const inner = memoryStore<Model>(null);
    const store: Store<Model> = {
      ...inner,
      async save(state) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await inner.save(state);
      },
    };
    const run = await start[engine](store);
    await run.ready();
    await run.dispatch({ type: "ask" });

    await run.letGo(way);
    expect(await inner.load()).toEqual({ asked: 1 });
    expect(run.probe.reports).toEqual([]);
  });

  it("a final save that rejects is reported under stop-save, and stop() returns", async () => {
    const inner = memoryStore<Model>(null);
    const boom = new Error("store down");
    let failing = false;
    const store: Store<Model> = {
      ...inner,
      async save(state) {
        if (failing) throw boom;
        await inner.save(state);
      },
    };
    const run = await start[engine](store);
    await run.ready();
    failing = true;

    const began = performance.now();
    await run.letGo(way);
    expect(performance.now() - began).toBeLessThan(LIMIT_MS);
    expect(run.probe.reports).toHaveLength(1);
    expect(run.probe.reports[0]?.phase).toBe("stop-save");
    expect(saveFailureOf(run.probe.reports[0]?.error)).toBe(boom);
  });
});
