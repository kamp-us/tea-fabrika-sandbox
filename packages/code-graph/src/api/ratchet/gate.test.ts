import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiRatchetVerdict } from "../../api.js";
import {
  bumped,
  CALLOUT,
  changeset,
  checkoutBranch,
  commitFiles,
  FIXTURE,
  git,
  MAP_FILE,
  PACKAGE_NAME,
  POLICY_FILE,
  type RatchetRepo,
  ratchetRepository,
  runCli,
  runGate,
} from "../../test-helpers/ratchet-repo.js";

let repo: RatchetRepo;
let sha: string;
const scratch: string[] = [];

beforeAll(() => {
  repo = ratchetRepository();
  scratch.push(repo.top);
  sha = repo.base.slice(0, 7);
});

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const verdictOf = (stdout: string): ApiRatchetVerdict => JSON.parse(stdout) as ApiRatchetVerdict;

// What a miss names, without its before/after text.
const named = (verdict: ApiRatchetVerdict) =>
  verdict.misses.map(({ subpath, tier, name, kind, needs }) => ({
    row: `${name} in ${subpath} (${tier}) ${kind}`,
    needs,
  }));

function policyFile(policy: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-ratchet-policy-"));
  scratch.push(dir);
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, JSON.stringify(policy));
  return file;
}

const fixturePolicy = () =>
  JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")) as {
    callout: string;
    tiers: Record<string, unknown>;
    default?: unknown;
  };

describe("code-graph --api-policy — a CI job gates a PR on its caller's policy (SPEC §13.5)", () => {
  it("fails a changed stable name until a minor changeset with the callout lands", () => {
    checkoutBranch(repo, "stable-changed");
    const bare = runGate(repo);
    expect(bare.code).toBe(1);
    expect(bare.stdout).toBe(
      [
        'API RATCHET: parse in . (stable) changed — needs a minor changeset with a "**Breaking" callout; found none',
        "  before:",
        "    export declare function parse(text: string): number;",
        "  after:",
        "    export declare function parse(text: string, radix?: number): number;",
        `API RATCHET: 1 of 1 change misses its bump against ${sha}`,
        "",
      ].join("\n"),
    );
    expect(runGate(repo)).toEqual(bare);

    commitFiles(repo, { ".changeset/parse-radix.md": bumped("minor") });
    const quiet = runGate(repo);
    expect(quiet.code).toBe(1);
    expect(quiet.stdout).toContain(
      'API RATCHET: parse in . (stable) changed — needs a minor changeset with a "**Breaking" callout; found minor with no callout',
    );
    expect(runGate(repo)).toEqual(quiet);

    commitFiles(repo, { ".changeset/parse-radix.md": bumped("minor", true) });
    const called = runGate(repo);
    expect(called).toEqual({
      code: 0,
      stdout: `API RATCHET: pass — 1 change against ${sha}, highest changeset bump minor, callout found\n`,
      stderr: "",
    });
    expect(runGate(repo)).toEqual(called);
  });

  // One branch per policy row. `below` is the strongest changeset that still misses the row
  // (`null`: no changeset at all), `at` the weakest that meets it.
  const rows = [
    {
      branch: "stable-added",
      row: "format in . (stable) added",
      needs: { bump: "minor", callout: false },
      below: bumped("patch", true),
      at: bumped("minor"),
    },
    {
      branch: "stable-changed",
      row: "parse in . (stable) changed",
      needs: { bump: "minor", callout: true },
      below: bumped("patch", true),
      at: bumped("minor", true),
    },
    {
      branch: "stable-removed",
      row: "legacy in . (stable) removed",
      needs: { bump: "major", callout: true },
      below: bumped("minor", true),
      at: bumped("major", true),
    },
    {
      branch: "battery-added",
      row: "CAPACITY in ./battery (battery) added",
      needs: { bump: "patch", callout: false },
      below: null,
      at: bumped("patch"),
    },
    {
      branch: "battery-changed",
      row: "charge in ./battery (battery) changed",
      needs: { bump: "minor", callout: false },
      below: bumped("patch", true),
      at: bumped("minor"),
    },
    {
      branch: "battery-removed",
      row: "drain in ./battery (battery) removed",
      needs: { bump: "minor", callout: true },
      below: bumped("major"),
      at: bumped("minor", true),
    },
    {
      branch: "labs-changed",
      row: "flag in ./labs (experimental) changed",
      needs: { bump: "patch", callout: false },
      below: null,
      at: bumped("patch"),
    },
    {
      branch: "labs-removed",
      row: "trial in ./labs (experimental) removed",
      needs: { bump: "patch", callout: true },
      below: bumped("major"),
      at: bumped("patch", true),
    },
  ] as const;

  it.each(rows)("holds the $branch branch to its row: $row", ({
    branch,
    row,
    needs,
    below,
    at,
  }) => {
    checkoutBranch(repo, branch, below === null ? {} : { "change.md": below });
    const missed = runGate(repo, ["--json"]);
    expect(missed.code).toBe(1);
    expect(named(verdictOf(missed.stdout))).toEqual([{ row, needs }]);

    checkoutBranch(repo, branch, { "change.md": at });
    const met = runGate(repo, ["--json"]);
    expect(met.code).toBe(0);
    expect(verdictOf(met.stdout)).toMatchObject({ passed: true, misses: [] });
  });

  it("passes an added experimental name with no changeset, as its row asks for none", () => {
    checkoutBranch(repo, "labs-added");
    expect(runGate(repo)).toEqual({
      code: 0,
      stdout: `API RATCHET: pass — 1 change against ${sha}, highest changeset bump none, no callout\n`,
      stderr: "",
    });
  });

  it("judges all nine rows of one branch at once, each against its own rule", () => {
    const stable = [
      "format in . (stable) added",
      "legacy in . (stable) removed",
      "make in . (stable) changed",
    ];
    const missesWith = (changesets: Readonly<Record<string, string>>): readonly string[] => {
      checkoutBranch(repo, "every-row", changesets);
      return named(verdictOf(runGate(repo, ["--json"]).stdout)).map(({ row }) => row);
    };

    expect(missesWith({})).toEqual([
      ...stable,
      "CAPACITY in ./battery (battery) added",
      "charge in ./battery (battery) changed",
      "drain in ./battery (battery) removed",
      "flag in ./labs (experimental) changed",
      "trial in ./labs (experimental) removed",
    ]);
    expect(missesWith({ "a.md": bumped("patch") })).toEqual([
      ...stable,
      "charge in ./battery (battery) changed",
      "drain in ./battery (battery) removed",
      "trial in ./labs (experimental) removed",
    ]);
    expect(missesWith({ "a.md": bumped("minor", true) })).toEqual(["legacy in . (stable) removed"]);
    expect(missesWith({ "a.md": bumped("major", true) })).toEqual([]);
  });

  it("prints every miss with its before and after text, the same bytes on a second run", () => {
    checkoutBranch(repo, "every-row", { "a.md": bumped("patch") });
    const text = runGate(repo);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(
      [
        'API RATCHET: make in . (stable) changed — needs a minor changeset with a "**Breaking" callout; found patch with no callout',
        "  before:",
        "    export declare function make(options: Options): {",
        "        options: Options;",
        "    };",
        "    src/index.d.ts#Options: type Options = {",
        "        readonly retries: number;",
        "    };",
        "  after:",
        "    export declare function make(options: Options): {",
        "        options: Options;",
        "    };",
        "    src/index.d.ts#Options: type Options = {",
        "        readonly retries: number;",
        "        readonly delayMs?: number;",
        "    };",
      ].join("\n"),
    );
    expect(text.stdout).toContain(
      [
        "API RATCHET: format in . (stable) added — needs a minor changeset; found patch",
        "  after:",
        "    export declare function format(n: number): string;",
        'API RATCHET: legacy in . (stable) removed — needs a major changeset with a "**Breaking" callout; found patch with no callout',
        "  before:",
        "    export declare function legacy(): void;",
      ].join("\n"),
    );
    expect(
      text.stdout.endsWith(`API RATCHET: 6 of 9 changes miss their bump against ${sha}\n`),
    ).toBe(true);
    expect(runGate(repo)).toEqual(text);

    const json = runGate(repo, ["--json", "--pretty"]);
    expect(json.code).toBe(1);
    expect(verdictOf(json.stdout)).toMatchObject({
      passed: false,
      base: repo.base,
      package: PACKAGE_NAME,
      changesets: [".changeset/a.md"],
      highestBump: "patch",
      calloutFound: false,
    });
    expect(runGate(repo, ["--json", "--pretty"])).toEqual(json);
  });

  it("passes a branch that changes no published name, with no changeset", () => {
    checkoutBranch(repo, "no-api-change");
    expect(runGate(repo)).toEqual({
      code: 0,
      stdout: `API RATCHET: pass — 0 changes against ${sha}, highest changeset bump none, no callout\n`,
      stderr: "",
    });
    expect(verdictOf(runGate(repo, ["--json"]).stdout)).toEqual({
      passed: true,
      base: repo.base,
      package: PACKAGE_NAME,
      changesets: [],
      highestBump: "none",
      calloutFound: false,
      misses: [],
    });
  });
});

describe("code-graph --api-policy — which changesets count", () => {
  const verdictWith = (changesets: Readonly<Record<string, string>>): ApiRatchetVerdict => {
    checkoutBranch(repo, "stable-added", changesets);
    return verdictOf(runGate(repo, ["--json"]).stdout);
  };

  it("does not count a changeset for a different package", () => {
    const verdict = verdictWith({ "other.md": changeset({ "@demo/other": "major" }, CALLOUT) });
    expect(verdict).toMatchObject({
      passed: false,
      changesets: [],
      highestBump: "none",
      calloutFound: false,
    });
  });

  it("counts two changesets for the package as the higher of their bumps", () => {
    const verdict = verdictWith({ "b-small.md": bumped("patch"), "a-large.md": bumped("minor") });
    expect(verdict).toMatchObject({
      passed: true,
      changesets: [".changeset/a-large.md", ".changeset/b-small.md"],
      highestBump: "minor",
    });
  });

  it("reads the package's own bump from a changeset that names several packages", () => {
    const verdict = verdictWith({
      "both.md": changeset({ "@demo/other": "major", [PACKAGE_NAME]: "patch" }),
    });
    expect(verdict).toMatchObject({
      passed: false,
      changesets: [".changeset/both.md"],
      highestBump: "patch",
    });
  });

  it("never counts a changeset the base commit already holds, nor the README", () => {
    expect(fs.existsSync(path.join(repo.top, ".changeset", "shipped.md"))).toBe(true);
    const verdict = verdictWith({});
    expect(verdict).toMatchObject({ changesets: [], highestBump: "none", calloutFound: false });
  });

  it("counts a changeset the working tree holds but no commit does", () => {
    checkoutBranch(repo, "stable-added");
    fs.writeFileSync(path.join(repo.top, ".changeset", "draft.md"), bumped("minor"));
    const verdict = verdictOf(runGate(repo, ["--json"]).stdout);
    fs.rmSync(path.join(repo.top, ".changeset", "draft.md"));
    expect(verdict).toMatchObject({ passed: true, changesets: [".changeset/draft.md"] });
  });

  it("exits 2 naming a changeset whose frontmatter does not parse", () => {
    checkoutBranch(repo, "stable-added", { "broken.md": "no frontmatter here\n" });
    const refused = runGate(repo);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(
      "changeset .changeset/broken.md has no frontmatter that parses",
    );
  });
});

describe("code-graph --api-policy — refusals", () => {
  it("exits 2 naming a tier the diff reports and the policy leaves out, rather than passing", () => {
    const { callout, tiers } = fixturePolicy();
    const { battery: _battery, ...withoutBattery } = tiers;
    const partial = policyFile({ callout, tiers: withoutBattery });

    checkoutBranch(repo, "battery-changed", { "a.md": bumped("major", true) });
    const refused = runGate(repo, [], partial);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(
      'bump policy: subpath ./battery has tier "battery", which the policy gives no row and no default',
    );

    // A tier the diff does not report needs no row: the same policy still gates a stable change.
    checkoutBranch(repo, "stable-changed");
    expect(runGate(repo, [], partial).code).toBe(1);
  });

  it("judges an unnamed tier by the caller's default row when the policy states one", () => {
    const { callout, tiers } = fixturePolicy();
    const { battery: _battery, ...withoutBattery } = tiers;
    const row = {
      added: { bump: "major" },
      changed: { bump: "major" },
      removed: { bump: "major" },
    };
    const defaulted = policyFile({ callout, tiers: withoutBattery, default: row });

    checkoutBranch(repo, "battery-changed", { "a.md": bumped("minor") });
    const missed = runGate(repo, ["--json"], defaulted);
    expect(missed.code).toBe(1);
    expect(named(verdictOf(missed.stdout))).toEqual([
      { row: "charge in ./battery (battery) changed", needs: { bump: "major", callout: false } },
    ]);
  });

  it("exits 2 on a policy that fails the schema, before any emit", () => {
    const refused = runGate(repo, [], policyFile({ callout: "x", tiers: {}, strict: true }));
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("invalid bump policy:");
  });

  it("exits 2 on --api-policy without --api-base, and without --api", () => {
    const noBase = runCli([repo.root, "--api", MAP_FILE, "--api-policy", POLICY_FILE]);
    expect(noBase.code).toBe(2);
    expect(noBase.stdout).toBe("");
    expect(noBase.stderr).toContain("--api-policy needs --api-base <rev>");

    const noApi = runCli([repo.root, "--api-policy", POLICY_FILE]);
    expect(noApi.code).toBe(2);
    expect(noApi.stdout).toBe("");
    expect(noApi.stderr).toContain("--api-policy needs --api <map> --api-base <rev>");
  });

  it("exits 2 when the package has no name", () => {
    checkoutBranch(repo, "stable-added");
    commitFiles(repo, { "packages/demo/package.json": '{ "version": "1.0.0" }\n' });
    const refused = runGate(repo);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("package.json has no name");
  });

  it("writes a miss to --out and still exits 1, leaving the checkout as it was", () => {
    checkoutBranch(repo, "stable-removed");
    const state = () => ({
      status: git(repo.top, "--no-optional-locks", "status", "--porcelain=v1"),
      index: git(repo.top, "ls-files", "--stage"),
      head: git(repo.top, "rev-parse", "HEAD"),
      branch: git(repo.top, "symbolic-ref", "HEAD"),
    });
    const before = state();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-ratchet-out-"));
    scratch.push(outDir);
    const out = path.join(outDir, "verdict.txt");
    const run = runGate(repo, ["--out", out]);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(fs.readFileSync(out, "utf8")).toContain("API RATCHET: legacy in . (stable) removed");
    expect(state()).toEqual(before);
  });
});

describe("code-graph --api-policy — a branch behind its base (changesets count since the merge base)", () => {
  let behind: RatchetRepo;
  const released = {
    "r1-a.md": bumped("minor"),
    "r1-b.md": bumped("patch"),
    "r2-major.md": bumped("major", true),
    "r2-b.md": bumped("minor", true),
    "r3-a.md": bumped("patch"),
  };

  beforeAll(() => {
    behind = ratchetRepository();
    scratch.push(behind.top);
    // `main` gathers five changesets, then the branch is cut.
    commitFiles(
      behind,
      Object.fromEntries(
        Object.entries(released).map(([file, text]) => [`.changeset/${file}`, text]),
      ),
    );
    git(behind.top, "branch", "feature");
    // `main` ships three releases, each deleting the changesets it released.
    const release = (version: string, files: readonly string[]) => {
      for (const file of files) fs.rmSync(path.join(behind.top, ".changeset", file));
      const manifest = path.join(behind.root, "package.json");
      const json = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(manifest, `${JSON.stringify({ ...json, version }, null, 2)}\n`);
      commitFiles(behind, {});
    };
    release("2.0.0", ["r1-a.md", "r1-b.md"]);
    release("3.0.0", ["r2-major.md", "r2-b.md"]);
    release("3.0.1", ["r3-a.md"]);
    // The branch, still holding all five, removes a stable name with no changeset.
    git(behind.top, "checkout", "--quiet", "feature");
    fs.cpSync(path.join(FIXTURE, "branches", "stable-removed"), behind.root, { recursive: true });
    commitFiles(behind, {});
  });

  it("counts none of the five changesets main has released, and fails the breaking change", () => {
    for (const file of Object.keys(released)) {
      expect(fs.existsSync(path.join(behind.top, ".changeset", file))).toBe(true);
    }
    const run = runGate(behind, ["--json"]);
    expect(run.code).toBe(1);
    expect(verdictOf(run.stdout)).toMatchObject({
      passed: false,
      changesets: [],
      highestBump: "none",
      calloutFound: false,
    });
    expect(named(verdictOf(run.stdout))).toEqual([
      { row: "legacy in . (stable) removed", needs: { bump: "major", callout: true } },
    ]);
    expect(runGate(behind, ["--json"])).toEqual(run);
  });

  it("passes once the branch adds its own major changeset with the callout, counting only it", () => {
    commitFiles(behind, { ".changeset/legacy-gone.md": bumped("major", true) });
    const run = runGate(behind, ["--json"]);
    expect(run.code).toBe(0);
    expect(verdictOf(run.stdout)).toMatchObject({
      passed: true,
      changesets: [".changeset/legacy-gone.md"],
      highestBump: "major",
      calloutFound: true,
    });
    expect(runGate(behind, ["--json"])).toEqual(run);
  });

  it("counts the same files on the merge of the branch into main with HEAD^1 as the base", () => {
    git(behind.top, "checkout", "--quiet", "--detach", "main");
    git(behind.top, "merge", "--quiet", "--no-gpg-sign", "--no-edit", "feature");
    const run = runCli([
      behind.root,
      "--api",
      MAP_FILE,
      "--api-base",
      "HEAD^1",
      "--api-policy",
      POLICY_FILE,
      "--json",
    ]);
    git(behind.top, "checkout", "--quiet", "feature");
    expect(run.code).toBe(0);
    expect(verdictOf(run.stdout)).toMatchObject({
      changesets: [".changeset/legacy-gone.md"],
      highestBump: "major",
    });
  });

  it("exits 2 naming the rev when git finds no merge base, rather than comparing trees", () => {
    git(behind.top, "checkout", "--quiet", "--orphan", "stray");
    git(behind.top, "commit", "--quiet", "--no-gpg-sign", "-m", "stray");
    git(behind.top, "checkout", "--quiet", "feature");
    const refused = runCli([
      behind.root,
      "--api",
      MAP_FILE,
      "--api-base",
      "stray",
      "--api-policy",
      POLICY_FILE,
    ]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain('base rev "stray" has no merge base with HEAD');
    expect(refused.stderr).toContain("fetch more history");
  });
});
