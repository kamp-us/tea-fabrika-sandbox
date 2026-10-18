/**
 * A record-form `update` written inline in `defineMachine` that leaves a Msg
 * out is refused with a message that NAMES the missing cell (#643).
 *
 * The refusal was always there; the wording was not. With the `types`
 * overloads declared first, the compiler printed the failure of the LAST
 * overload (the plain `Reducer` one), which knows nothing of `types` or
 * `cmds`: "No overload matches this call … not assignable to type 'never'",
 * on cells that were fine, and no word of the one that was missing. The
 * `types` overloads now come last, so the failure printed is the one the
 * author meant: `Property '<cell>' is missing …`.
 *
 * Every case is one file of ONE in-memory program, so the compiler runs once
 * (#573: a compile inside a test is slow).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cacheDir,
  PKG_ROOT,
  programDiagnostics,
} from "../docs/in-memory-program";
import { tsBlocksOf } from "../docs/page-mirrors";

/** The `order` machine, as the how-to page shows it: three Cmds, seven cells, inline, `types` plus `cmds`. */
const ORDER = tsBlocksOf(
  readFileSync(
    join(PKG_ROOT, "docs/how-to/test-a-machine-with-drive.md"),
    "utf8",
  ),
)[0] as string;

/** `ORDER` with the named cells of its `update` record cut out. */
function orderWithout(...cells: readonly string[]): string {
  let text = ORDER;
  for (const cell of cells) {
    // A cell starts at four spaces of indent and runs to the next cell or the
    // record's closing brace.
    const next = text.replace(
      new RegExp(`^ {4}${cell}: [\\s\\S]*?(?=^ {4}\\w+: |^ {2}\\},)`, "m"),
      "",
    );
    if (next === text) throw new Error(`no cell ${cell} in the order machine`);
    text = next;
  }
  return text;
}

const SETTLE_CELLS = [
  "reserve_stock_ok",
  "reserve_stock_err",
  "charge_card_ok",
  "charge_card_err",
  "ship_parcel_ok",
  "ship_parcel_err",
] as const;

/** A machine with `types`, no `cmds`, three own Msgs; `review_done` left out. */
const NO_CMDS_UNION = `
import { defineMachine } from "@demlik/tea";

type State =
  | { readonly type: "idle" }
  | { readonly type: "busy"; readonly text: string };
type Msg =
  | { readonly type: "start"; readonly text: string }
  | { readonly type: "cancel" }
  | { readonly type: "review_done" };

const idle: State = { type: "idle" };

export const reviewer = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  init: (loaded) => [loaded ?? idle, []],
  update: {
    start: (_s, m) => [{ type: "busy", text: m.text }, []],
    cancel: (_s) => [idle, []],
  },
});
`;

/** The same on a flat object Model. */
const NO_CMDS_FLAT = `
import { defineMachine } from "@demlik/tea";

interface State {
  readonly count: number;
  readonly label: string;
}
type Msg =
  | { readonly type: "inc" }
  | { readonly type: "rename"; readonly label: string }
  | { readonly type: "reset_all" };

export const counter = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  init: (loaded) => [loaded ?? { count: 0, label: "" }, []],
  update: {
    inc: (s) => [{ ...s, count: s.count + 1 }, []],
    rename: (s, m) => [{ ...s, label: m.label }, []],
  },
});
`;

/** An annotated `Reducer` value with `verdict_err` left out: named before #643, still named. */
const ANNOTATED = `
import { Cmd, defineMachine, type Reducer, type Settled } from "@demlik/tea";
import { z } from "zod";

const verdict = Cmd.define("verdict", {
  input: z.object({ payload: z.string() }),
  ok: z.object({ taken: z.boolean() }),
  err: ["refused"],
});

interface State {
  readonly text: string;
  readonly taken: boolean;
}
type Own = { readonly type: "review"; readonly text: string };

const update: Reducer<
  State,
  Own | Settled<typeof verdict>,
  ReturnType<typeof verdict>
> = {
  review: (s, m) => [{ ...s, text: m.text }, [verdict({ payload: m.text })]],
  verdict_ok: (s, m) => [{ ...s, taken: m.value.taken }, []],
};

export const reviewer = defineMachine({
  types: { model: {} as State, msg: {} as Own },
  cmds: [verdict],
  init: (loaded) => [loaded ?? { text: "", taken: false }, []],
  update,
});
`;

const cases = new Map<string, string>([
  ["complete.ts", ORDER],
  ...SETTLE_CELLS.map(
    (cell) => [`without-${cell}.ts`, orderWithout(cell)] as const,
  ),
  ["without-two.ts", orderWithout("charge_card_err", "reserve_stock_err")],
  [
    "without-three.ts",
    orderWithout("charge_card_err", "reserve_stock_err", "ship_parcel_ok"),
  ],
  ["no-cmds-union.ts", NO_CMDS_UNION],
  ["no-cmds-flat.ts", NO_CMDS_FLAT],
  ["annotated.ts", ANNOTATED],
]);

describe(
  "an inline record that leaves a cell out names the cell",
  { timeout: 120_000 },
  () => {
    // One compile for every case, read per file below.
    let byFile: Map<string, string[]> | undefined;
    const diagnosticsOf = (file: string): string[] => {
      if (byFile === undefined) {
        byFile = new Map();
        const all = programDiagnostics(cacheDir("tea-missing-cell"), cases, {
          noUnusedLocals: false,
        });
        for (const line of all) {
          const name = line.slice(0, line.indexOf(":"));
          byFile.set(name, [...(byFile.get(name) ?? []), line]);
        }
      }
      return byFile.get(file) ?? [];
    };

    /**
     * True when some diagnostic of `file` names `cell` in its message. The
     * `<file>:<line> ` prefix is cut first: a file is named after its cell.
     */
    const names = (file: string, cell: string): boolean =>
      diagnosticsOf(file).some((d) => d.slice(d.indexOf(" ")).includes(cell));

    it("compiles the complete order machine with no diagnostics", () => {
      expect(diagnosticsOf("complete.ts")).toEqual([]);
    });

    it.each(SETTLE_CELLS)("names %s when it is left out", (cell) => {
      const file = `without-${cell}.ts`;
      expect(diagnosticsOf(file)).not.toEqual([]);
      expect(names(file, cell), diagnosticsOf(file).join("\n")).toBe(true);
    });

    it("names both cells when two are left out", () => {
      for (const cell of ["charge_card_err", "reserve_stock_err"]) {
        expect(names("without-two.ts", cell), cell).toBe(true);
      }
    });

    it("names all three cells when three are left out", () => {
      for (const cell of [
        "charge_card_err",
        "reserve_stock_err",
        "ship_parcel_ok",
      ]) {
        expect(names("without-three.ts", cell), cell).toBe(true);
      }
    });

    it("names the missing Msg without cmds, on a union Model", () => {
      expect(names("no-cmds-union.ts", "review_done")).toBe(true);
    });

    it("names the missing Msg without cmds, on a flat object Model", () => {
      expect(names("no-cmds-flat.ts", "reset_all")).toBe(true);
    });

    it("still names the cell an annotated Reducer leaves out", () => {
      expect(names("annotated.ts", "verdict_err")).toBe(true);
    });
  },
);
