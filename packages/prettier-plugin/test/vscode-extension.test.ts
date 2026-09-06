import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import plugin from "../src/index.js";

/**
 * The editor extension, checked as far as it can be checked here.
 *
 * Nothing in this repository can launch VS Code, so this does not prove the
 * grammar highlights anything. What it does prove is that the files parse,
 * that every path the manifest names exists, that the patterns are well formed
 * rather than silently ignored, and that the two language ids match the ones
 * `@sweetener/prettier-plugin` already declares — which is what makes
 * formatting a `.sts` work from inside the editor.
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

interface Grammar {
  readonly scopeName: string;
  readonly patterns: readonly { readonly include?: string }[];
  readonly repository: Readonly<
    Record<
      string,
      {
        readonly match?: string;
        readonly begin?: string;
        readonly end?: string;
        readonly name?: string;
        readonly captures?: Readonly<Record<string, { readonly name: string }>>;
        readonly beginCaptures?: Readonly<
          Record<string, { readonly name: string }>
        >;
      }
    >
  >;
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

  test("names a rule for every pattern it includes", () => {
    for (const pattern of grammar.patterns) {
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
    for (const [name, rule] of Object.entries(grammar.repository))
      for (const expression of [rule.match, rule.begin, rule.end])
        if (expression !== undefined)
          expect(
            () => new RegExp(expression, "u"),
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
    for (const [name, rule] of Object.entries(grammar.repository)) {
      const expression = rule.match ?? rule.begin;
      if (expression === undefined) continue;
      expect(
        new RegExp(expression, "u").test(sources),
        `${name} matches nothing in the examples`,
      ).toBe(true);
    }
  });

  test("scopes what it matches", () => {
    for (const [name, rule] of Object.entries(grammar.repository)) {
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
