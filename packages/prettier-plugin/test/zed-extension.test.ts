import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The Zed extension must recognize `.sts` and `.stsx` without becoming Zed's
 * TypeScript or TSX language. Those names are what a user's existing
 * `typescript-ls` / `oxlint` / `oxfmt` settings attach to.
 */

const extensionRoot = resolve(import.meta.dirname, "../../../editors/zed");

const queryFiles = [
  "highlights.scm",
  "brackets.scm",
  "indents.scm",
  "outline.scm",
  "overrides.scm",
  "injections.scm",
] as const;

function read(path: string): string {
  return readFileSync(join(extensionRoot, path), "utf8");
}

function languageDirs(): string[] {
  return readdirSync(join(extensionRoot, "languages")).sort();
}

describe("the Zed extension", () => {
  const manifest = read("extension.toml");

  test("registers Sweetener languages, not TypeScript or TSX", () => {
    expect(languageDirs()).toEqual(["sweetener-tsx", "sweetener-typescript"]);
    expect(manifest).toContain('id = "sweetener"');
    expect(manifest).not.toMatch(/^\[language_servers\./m);
    // Zed links `tree_sitter_<grammar name>`. These parsers export
    // `tree_sitter_typescript` and `tree_sitter_tsx`, so the keys have to match.
    expect(manifest).toContain("[grammars.typescript]");
    expect(manifest).toContain("[grammars.tsx]");
    expect(manifest).not.toContain("sweetener_typescript");
    expect(manifest).not.toContain("sweetener_tsx");
  });

  test("claims only .sts and .stsx", () => {
    const typescript = read("languages/sweetener-typescript/config.toml");
    const tsx = read("languages/sweetener-tsx/config.toml");

    expect(typescript).toContain('name = "Sweetener TypeScript"');
    expect(typescript).toContain('grammar = "typescript"');
    expect(typescript).toContain('path_suffixes = ["sts"]');

    expect(tsx).toContain('name = "Sweetener TSX"');
    expect(tsx).toContain('grammar = "tsx"');
    expect(tsx).toContain('path_suffixes = ["stsx"]');

    for (const config of [typescript, tsx]) {
      expect(config).not.toContain("prettier_parser_name");
      expect(config).not.toContain("first_line_pattern");
      expect(config).not.toMatch(/path_suffixes = \[[^\]]*"tsx?"/);
    }
  });

  test("ships a query file for each editor feature", () => {
    for (const language of languageDirs()) {
      for (const file of queryFiles) {
        expect(
          read(join("languages", language, file)).length,
          `${language}/${file}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("keeps JSX nodes out of the .sts grammar queries", () => {
    for (const file of queryFiles) {
      expect(
        read(join("languages", "sweetener-typescript", file)),
        file,
      ).not.toContain("jsx_");
    }
    expect(read("languages/sweetener-tsx/highlights.scm")).toContain(
      "jsx_opening_element",
    );
  });

  test("does not use nvim-only query predicates", () => {
    for (const language of languageDirs()) {
      for (const file of queryFiles) {
        expect(
          read(join("languages", language, file)),
          `${language}/${file}`,
        ).not.toContain("#is-not?");
      }
    }
  });
});
