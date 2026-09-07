import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import plugin from "../src/index.js";

/**
 * The editor extension's manifest and the shape of its grammar.
 *
 * What the scopes actually land on is checked in `vscode-grammar.test.ts`, by
 * running the grammar through the tokenizer VS Code runs it through. What is
 * left here is everything that is true of the files rather than of the
 * tokenization: that they parse, that every path the manifest names exists,
 * that the patterns are well formed rather than silently ignored, and that the
 * two language ids match the ones `@sweetener/prettier-plugin` already
 * declares — which is what makes formatting a `.sts` work from inside the
 * editor.
 */

const extensionRoot = resolve(import.meta.dirname, "../../../editors/vscode");

function json<T>(...segments: string[]): T {
  return JSON.parse(
    readFileSync(join(extensionRoot, ...segments), "utf8"),
  ) as T;
}

interface Manifest {
  readonly contributes: {
    readonly languages: readonly {
      readonly id: string;
      readonly extensions: readonly string[];
      readonly configuration: string;
    }[];
    readonly grammars: readonly {
      readonly language: string;
      readonly scopeName: string;
      readonly path: string;
    }[];
  };
}

interface Rule {
  readonly match?: string;
  readonly begin?: string;
  readonly end?: string;
  readonly while?: string;
  readonly name?: string;
  readonly include?: string;
  readonly patterns?: readonly Rule[];
  readonly captures?: Readonly<Record<string, { readonly name: string }>>;
  readonly beginCaptures?: Readonly<Record<string, { readonly name: string }>>;
}

interface Grammar {
  readonly scopeName: string;
  readonly patterns: readonly Rule[];
  readonly injections: Readonly<Record<string, { readonly patterns: Rule[] }>>;
  readonly repository: Readonly<Record<string, Rule>>;
}

/**
 * Every rule under a repository entry, named by the path that reaches it.
 *
 * Some entries are a single pattern and some are a list of them — the clause
 * keywords are nine separate patterns under one name — so a check that only
 * looked at the top of each entry would silently skip most of the grammar.
 */
function rules(grammar: Grammar): [string, Rule][] {
  const found: [string, Rule][] = [];
  const visit = (name: string, rule: Rule): void => {
    if (rule.include === undefined) found.push([name, rule]);
    (rule.patterns ?? []).forEach((nested, index) => {
      visit(`${name}[${String(index)}]`, nested);
    });
  };
  for (const [name, rule] of Object.entries(grammar.repository))
    visit(name, rule);
  return found;
}

/** The expressions one rule searches with. */
function expressions(rule: Rule): string[] {
  return [rule.match, rule.begin, rule.end, rule.while].filter(
    (expression): expression is string => expression !== undefined,
  );
}

describe("the VS Code extension", () => {
  const manifest = json<Manifest>("package.json");
  const grammar = json<Grammar>("syntaxes", "sweetener.tmLanguage.json");

  test("registers the extensions Sweetener uses", () => {
    expect(
      manifest.contributes.languages.map(({ id, extensions }) => [
        id,
        extensions,
      ]),
    ).toEqual([
      ["sweetener-typescript", [".sts"]],
      ["sweetener-typescriptreact", [".stsx"]],
    ]);
  });

  test("uses the language ids the Prettier plugin declares", () => {
    // The plugin names these so an editor can route a `.sts` to it. If the two
    // ever disagree, formatting from the editor silently stops working.
    const declared = (plugin.languages ?? []).flatMap(
      (language) => language.vscodeLanguageIds ?? [],
    );
    expect(new Set(declared)).toEqual(
      new Set(manifest.contributes.languages.map(({ id }) => id)),
    );
  });

  test("names files that exist", () => {
    for (const language of manifest.contributes.languages)
      expect(() =>
        readFileSync(join(extensionRoot, language.configuration), "utf8"),
      ).not.toThrow();
    for (const contributed of manifest.contributes.grammars) {
      expect(() =>
        readFileSync(join(extensionRoot, contributed.path), "utf8"),
      ).not.toThrow();
      expect(contributed.scopeName).toBe(grammar.scopeName);
    }
  });

  test("falls through to the TypeScript grammar", () => {
    // Everything Sweetener does not add is ordinary TSX, and the last pattern
    // is what makes the rest of the file highlight at all.
    expect(grammar.patterns.at(-1)).toEqual({ include: "source.tsx" });
  });

  test("injects the macro syntax rather than listing it beside TypeScript", () => {
    // A pattern listed next to `source.tsx` is unreachable as soon as a
    // TypeScript rule opens a region, which is on the first `export` of the
    // first line. Only an injection applies inside one. Every selector is
    // scoped to this grammar and to a context the syntax it adds is legal in.
    const selectors = Object.keys(grammar.injections);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith("L:source.sweetener")).toBe(true);
      expect(selector).toMatch(/meta\.(?:import\.tsx|macro\.sweetener)/u);
    }
  });

  test("names a rule for every pattern it includes", () => {
    const includes = [
      ...grammar.patterns,
      ...Object.values(grammar.injections).flatMap(({ patterns }) => patterns),
      ...Object.values(grammar.repository).flatMap(
        (rule) => rule.patterns ?? [],
      ),
    ];
    for (const pattern of includes) {
      const include = pattern.include;
      if (include === undefined || !include.startsWith("#")) continue;
      expect(
        Object.keys(grammar.repository),
        `${include} is included but not defined`,
      ).toContain(include.slice(1));
    }
  });

  test("compiles every expression in the grammar", () => {
    // A TextMate pattern that does not compile is dropped in silence, taking
    // its highlighting with it. Oniguruma is not JavaScript's engine, but
    // these patterns are written in the subset both accept.
    for (const [name, rule] of rules(grammar))
      for (const expression of expressions(rule))
        expect(
          () => new RegExp(expression, "mu"),
          `${name} has an expression that does not compile`,
        ).not.toThrow();
  });

  /**
   * A pattern that matches nothing is not highlighting anything. These are
   * checked against the language tour and the macro suite, which between them
   * use every form the grammar claims to know.
   */
  test("matches the syntax in the checked-in examples", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const sources = [
      "examples/macro-suite/macros.sts",
      "examples/macro-suite/showcase.sts",
      ...readdirSync(join(root, "examples/language-tour"), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((entry) => entry.endsWith(".sts") || entry.endsWith(".stsx"))
        .map((entry) => join("examples/language-tour", entry)),
    ]
      .map((relative) => readFileSync(join(root, relative), "utf8"))
      .join("\n");
    for (const [name, rule] of rules(grammar)) {
      const expression = rule.match ?? rule.begin;
      if (expression === undefined) continue;
      expect(
        new RegExp(expression, "mu").test(sources),
        `${name} matches nothing in the examples`,
      ).toBe(true);
    }
  });

  test("scopes what it matches", () => {
    for (const [name, rule] of rules(grammar)) {
      if (expressions(rule).length === 0) continue;
      const scopes = [
        rule.name,
        ...Object.values(rule.captures ?? {}).map((capture) => capture.name),
        ...Object.values(rule.beginCaptures ?? {}).map(
          (capture) => capture.name,
        ),
      ].filter((scope): scope is string => scope !== undefined);
      expect(
        scopes.length,
        `${name} matches text but scopes none of it`,
      ).toBeGreaterThan(0);
      for (const scope of scopes) expect(scope).toMatch(/\.sweetener$/u);
    }
  });
});
