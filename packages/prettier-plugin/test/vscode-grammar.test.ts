import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import textmate from "vscode-textmate";
import type { IOnigLib } from "vscode-textmate";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * The editor extension's grammar, run through the engine VS Code runs it
 * through.
 *
 * `vscode-textmate` and `vscode-oniguruma` are what tokenizes a file in the
 * editor, and VS Code's own TSX grammar is what the Sweetener grammar embeds,
 * so registering all three here produces the scopes a reader would actually
 * see. That matters more than it sounds: the first version of this grammar
 * listed its patterns ahead of `source.tsx` and produced not one Sweetener
 * scope on any file in this repository, because TypeScript's rules open a
 * region at the start of `export …` and win, and a top-level pattern cannot
 * reach inside one. Every check here is a scope on a span of real source.
 */

const { INITIAL, Registry, parseRawGrammar } = textmate;

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../..");

/**
 * The regular-expression engine, loaded through `require`.
 *
 * Importing it would pull its declarations into the build, and they name the
 * `WebAssembly` namespace, which TypeScript only declares in the DOM library.
 * Adding that library to a Node package to satisfy one dependency would hand
 * every file in it `document` and `window` as well. The two functions the
 * registry wants are exactly `IOnigLib`.
 */
const { createOnigScanner, createOnigString, loadWASM } =
  require("vscode-oniguruma") as IOnigLib & {
    loadWASM(data: ArrayBufferLike): Promise<void>;
  };

interface Token {
  readonly text: string;
  readonly scopes: readonly string[];
}

let grammar: textmate.IGrammar;

beforeAll(async () => {
  await loadWASM(
    readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer,
  );
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: (scopeName) => {
      const path =
        scopeName === "source.sweetener"
          ? resolve(root, "editors/vscode/syntaxes/sweetener.tmLanguage.json")
          : scopeName === "source.tsx"
            ? require.resolve("tm-grammars/grammars/tsx.json")
            : undefined;
      return Promise.resolve(
        path === undefined
          ? null
          : parseRawGrammar(readFileSync(path, "utf8"), path),
      );
    },
  });
  const loaded = await registry.loadGrammar("source.sweetener");
  if (loaded === null) throw new Error("the Sweetener grammar did not load");
  grammar = loaded;
});

/** Every non-blank token in `source`, with the scopes the editor gives it. */
function paint(source: string): Token[] {
  const tokens: Token[] = [];
  let stack = INITIAL;
  for (const line of source.split("\n")) {
    const result = grammar.tokenizeLine(line, stack);
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex);
      if (text.trim() !== "") tokens.push({ text, scopes: token.scopes });
    }
    stack = result.ruleStack;
  }
  return tokens;
}

/** The file at `path`, painted. */
function paintFile(path: string): Token[] {
  return paint(readFileSync(resolve(root, path), "utf8"));
}

/**
 * The scopes on one token, named by its text.
 *
 * Naming the span rather than an index is what keeps these assertions
 * readable, and throwing when the span is not a token of its own is the point
 * as often as the scopes are: a pattern that matched two characters too many
 * shows up here as a missing token.
 */
function scopesOf(
  tokens: readonly Token[],
  text: string,
  occurrence = 0,
): readonly string[] {
  const matches = tokens.filter((token) => token.text === text);
  const token = matches[occurrence];
  if (token === undefined)
    throw new Error(
      `no token ${JSON.stringify(text)} at occurrence ${String(occurrence)}; ` +
        `the file has ${String(matches.length)} of them`,
    );
  return token.scopes;
}

/** Whether any token whose text is `text` carries `scope`. */
function anyScoped(
  tokens: readonly Token[],
  text: string,
  scope: string,
): boolean {
  return tokens.some(
    (token) => token.text === text && token.scopes.includes(scope),
  );
}

/** The Sweetener scopes on the tokens of `tokens`, ignoring the file's root. */
function sweetenerScopes(tokens: readonly Token[]): string[] {
  return [
    ...new Set(
      tokens.flatMap((token) =>
        token.scopes.filter(
          (scope) =>
            scope.endsWith(".sweetener") && scope !== "source.sweetener",
        ),
      ),
    ),
  ];
}

describe("a macro definition", () => {
  test("scopes the head of `export syntax twice:expr`", () => {
    const tokens = paintFile("examples/macro-suite/macros.sts");
    expect(scopesOf(tokens, "export")).toContain(
      "keyword.control.export.sweetener",
    );
    expect(scopesOf(tokens, "syntax")).toContain("storage.type.sweetener");
    expect(scopesOf(tokens, "twice")).toContain(
      "entity.name.function.macro.sweetener",
    );
    expect(scopesOf(tokens, "expr")).toContain(
      "support.type.category.sweetener",
    );
  });

  test("leaves the body's braces to the TypeScript grammar", () => {
    // The head ends at the brace rather than consuming it, so the block, and
    // everything nested in it, is still TypeScript's to tokenize.
    const tokens = paintFile("examples/macro-suite/macros.sts");
    expect(scopesOf(tokens, "{")).toContain("punctuation.definition.block.tsx");
    expect(scopesOf(tokens, "}")).toContain("punctuation.definition.block.tsx");
  });

  test("scopes `export operator (|>):expr` by the spelling in parentheses", () => {
    const tokens = paintFile("examples/macro-suite/macros.sts");
    expect(scopesOf(tokens, "operator")).toContain("storage.type.sweetener");
    expect(scopesOf(tokens, "(|>)")).toContain(
      "entity.name.function.macro.sweetener",
    );
    expect(anyScoped(tokens, "infix", "keyword.control.sweetener")).toBe(true);
    expect(anyScoped(tokens, "left", "keyword.control.sweetener")).toBe(true);
    expect(anyScoped(tokens, "40", "constant.numeric.sweetener")).toBe(true);
  });

  test("scopes `rec`, which a recursive operator is declared with", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/threading/macros.sts",
    );
    expect(scopesOf(tokens, "rec")).toContain("storage.modifier.sweetener");
    expect(scopesOf(tokens, "(->)")).toContain(
      "entity.name.function.macro.sweetener",
    );
  });

  test("scopes `syntax class`, which declares a class and takes no category", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/protocols/macros.sts",
    );
    expect(scopesOf(tokens, "class")).toContain("storage.type.sweetener");
    expect(scopesOf(tokens, "ProtocolParameter")).toContain(
      "entity.name.type.class.sweetener",
    );
    expect(scopesOf(tokens, "fields")).toContain("keyword.control.sweetener");
  });

  test("scopes `shadows core` on the definition", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/core-rewrites/macros.sts",
    );
    expect(scopesOf(tokens, "shadows")).toContain("keyword.control.sweetener");
    expect(scopesOf(tokens, "core")).toContain("keyword.control.sweetener");
  });

  test("opens no region in a file that defines no macros", () => {
    // Most `.sts` and `.stsx` files only use macros. Nothing in one of those
    // is inside a definition, so nothing in one may be painted as if it were.
    const tokens = paintFile("examples/macro-suite/showcase.sts");
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens)
      expect(token.scopes).not.toContain("meta.macro.sweetener");
  });
});

describe("a rule", () => {
  const source =
    "export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value] }\n}\n";

  test("scopes `rule`, the capture, its sigil, and its category", () => {
    const tokens = paint(source);
    expect(scopesOf(tokens, "rule")).toContain("keyword.control.sweetener");
    expect(scopesOf(tokens, "$", 0)).toContain(
      "punctuation.definition.variable.sweetener",
    );
    expect(scopesOf(tokens, "value", 0)).toContain(
      "variable.parameter.capture.sweetener",
    );
    expect(scopesOf(tokens, "expr", 1)).toContain(
      "support.type.category.sweetener",
    );
  });

  test("scopes the expansion arrow apart from an arrow function", () => {
    const tokens = paint(source);
    expect(scopesOf(tokens, "=>")).toContain(
      "keyword.operator.expansion.sweetener",
    );
    expect(scopesOf(tokens, "=>")).not.toContain(
      "storage.type.function.arrow.tsx",
    );
  });

  test("scopes the arrow the formatter has moved onto its own line", () => {
    // `surround` in the macro suite is printed with the arrow leading the
    // template line, so a same-line lookbehind alone would miss it.
    const tokens = paintFile("examples/macro-suite/macros.sts");
    const arrows = tokens.filter((token) => token.text === "=>");
    expect(arrows.length).toBeGreaterThan(1);
    for (const arrow of arrows)
      expect(arrow.scopes).toContain("keyword.operator.expansion.sweetener");
  });

  test("scopes the capture inside a repetition", () => {
    const tokens = paintFile(
      "examples/language-tour/new/variadic-array/macros.sts",
    );
    // `arrayOf($($value:expr),+)`: the first `$` opens the repetition and the
    // second is the capture inside it.
    expect(scopesOf(tokens, "$", 0)).toContain(
      "punctuation.definition.repetition.sweetener",
    );
    expect(scopesOf(tokens, "$", 1)).toContain(
      "punctuation.definition.variable.sweetener",
    );
    expect(scopesOf(tokens, "value", 0)).toContain(
      "variable.parameter.capture.sweetener",
    );
    expect(scopesOf(tokens, "expr", 1)).toContain(
      "support.type.category.sweetener",
    );
  });

  test("scopes the other clauses a definition can carry", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/core-rewrites/macros.sts",
    );
    expect(anyScoped(tokens, "literal", "keyword.control.sweetener")).toBe(
      true,
    );
    expect(anyScoped(tokens, "fallback", "keyword.control.sweetener")).toBe(
      true,
    );
    expect(anyScoped(tokens, "bind", "keyword.control.sweetener")).toBe(true);
    expect(anyScoped(tokens, "expect", "keyword.control.sweetener")).toBe(true);
  });
});

describe("a template operation", () => {
  test("scopes `#core` and its `#`", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/core-rewrites/macros.sts",
    );
    expect(scopesOf(tokens, "#")).toContain(
      "punctuation.definition.keyword.sweetener",
    );
    expect(scopesOf(tokens, "core", 1)).toContain(
      "support.function.operation.sweetener",
    );
  });

  test("scopes `#join`", () => {
    const tokens = paintFile("playground/examples/signals/macros.sts");
    expect(scopesOf(tokens, "join")).toContain(
      "support.function.operation.sweetener",
    );
    expect(scopesOf(tokens, "metavar")).toContain(
      "support.function.operation.sweetener",
    );
  });

  test("scopes the operations that take a brace group as well", () => {
    // `#if` and `#else` are followed by a group rather than by arguments, so a
    // rule that insisted on a parenthesis would miss half the template.
    const tokens = paintFile(
      "examples/language-tour/recovered/structural-matching/macros.sts",
    );
    for (const operation of ["if", "else", "text", "count", "index"])
      expect(
        anyScoped(tokens, operation, "support.function.operation.sweetener"),
        `#${operation} is not scoped as an operation`,
      ).toBe(true);
  });

  test("leaves a private member alone", () => {
    // `#name(` is also how TypeScript calls a private method. Painting one as
    // an operation inside a template would be a lie about what runs.
    const tokens = paint(
      "export syntax hide:item {\n" +
        "  rule { hide() }\n" +
        "  => {\n" +
        "    #core(class Counter {\n" +
        "        #count = 0;\n" +
        "        bump() { return this.#count(1); }\n" +
        "      })\n" +
        "  }\n" +
        "}\n",
    );
    const operations = tokens.filter((token) =>
      token.scopes.includes("support.function.operation.sweetener"),
    );
    expect(operations.map((token) => token.text)).toEqual(["core"]);
  });
});

describe("a compile-time import", () => {
  test("scopes `for syntax` and leaves the rest to TypeScript", () => {
    const tokens = paintFile(
      "examples/language-tour/new/duplicate-expression/main.sts",
    );
    expect(scopesOf(tokens, "for")).toContain(
      "keyword.control.import.sweetener",
    );
    expect(scopesOf(tokens, "syntax")).toContain(
      "keyword.control.import.sweetener",
    );
    expect(scopesOf(tokens, "import")).toContain("keyword.control.import.tsx");
    expect(scopesOf(tokens, "./macros.sts")).toContain(
      "string.quoted.double.tsx",
    );
  });

  test("scopes `shadows core` and leaves a shadowed core form readable", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/core-rewrites/main.sts",
    );
    expect(scopesOf(tokens, "shadows")).toContain(
      "keyword.control.import.sweetener",
    );
    expect(scopesOf(tokens, "core")).toContain(
      "keyword.control.import.sweetener",
    );
    // `typeof` and `function` are imported here as ordinary names. Nothing may
    // paint them as the TypeScript operators they are not.
    expect(scopesOf(tokens, "typeof")).toContain("meta.import.tsx");
    expect(scopesOf(tokens, "typeof")).not.toContain(
      "keyword.operator.expression.typeof.tsx",
    );
  });

  test("scopes an operator imported by its spelling", () => {
    const tokens = paintFile("examples/macro-suite/showcase.sts");
    expect(scopesOf(tokens, "(|>)")).toContain(
      "entity.name.function.macro.sweetener",
    );
  });
});

describe("ordinary TypeScript in a Sweetener file", () => {
  test("still gets TypeScript's scopes, JSX included", () => {
    const tokens = paintFile(
      "examples/language-tour/recovered/jsx-control-flow/main.stsx",
    );
    expect(scopesOf(tokens, "const")).toContain("storage.type.tsx");
    expect(scopesOf(tokens, "./macros.sts")).toContain(
      "string.quoted.double.tsx",
    );
    expect(anyScoped(tokens, "ul", "entity.name.tag.tsx")).toBe(true);
    expect(
      tokens.some((token) =>
        token.scopes.includes("comment.line.double-slash.tsx"),
      ),
    ).toBe(true);
  });

  test("keeps the clause keywords as identifiers outside a definition", () => {
    // `rule`, `precedence`, `left` and `none` are ordinary names in
    // TypeScript, and a `.sts` file is mostly ordinary TypeScript. A grammar
    // that recognised them anywhere would repaint application code.
    const tokens = paint(
      "const rule = 1;\n" +
        "const precedence = 2;\n" +
        "const left = 3;\n" +
        "const bounds = { left: 1, right: 2, none: 3 };\n" +
        "const $dollar = 4;\n",
    );
    expect(sweetenerScopes(tokens)).toEqual([]);
  });

  test("keeps them as identifiers after a definition has closed", () => {
    // A definition is a module item, so its region has to end on the brace in
    // column one and not one line later.
    const tokens = paint(
      "export syntax twice:expr {\n" +
        "  rule { twice($value:expr) } => { [$value, $value] }\n" +
        "}\n" +
        "\n" +
        "const rule = 1;\n" +
        "const $dollar = 2;\n",
    );
    expect(scopesOf(tokens, "rule", 1)).not.toContain(
      "keyword.control.sweetener",
    );
    expect(scopesOf(tokens, "rule", 1)).not.toContain("meta.macro.sweetener");
    expect(scopesOf(tokens, "$dollar")).not.toContain(
      "variable.parameter.capture.sweetener",
    );
  });

  test("is untouched in a file that only imports macros", () => {
    // `function` is imported here as a name, through a core shadow, into a
    // file that is otherwise React. Nothing but the import tail is Sweetener's.
    const tokens = paintFile(
      "examples/react-memoization/src/function-shadow.stsx",
    );
    expect(scopesOf(tokens, "function", 0)).toContain("meta.import.tsx");
    expect(anyScoped(tokens, "main", "entity.name.tag.tsx")).toBe(true);
    expect(sweetenerScopes(tokens)).toEqual([
      "keyword.control.import.sweetener",
    ]);
  });
});

describe("a capture", () => {
  // Four positions inside one template, named apart so each assertion names
  // the span it is about. A template holds ordinary TypeScript, so `$name` in
  // a string's text or in JSX text is text, and `$name` in a substitution or
  // an expression container is a capture.
  const source =
    "export syntax card:item {\n" +
    "  rule { card($name:binding) }\n" +
    "  => {\n" +
    "    #core(function $name() {\n" +
    "        const label = `plain $inText text ${$inSubstitution}`;\n" +
    '        return <b className="card">plain $inChildren text{$inContainer}</b>;\n' +
    "      })\n" +
    "  }\n" +
    "}\n";

  test("is not a capture in a template literal's text", () => {
    const literal = scopesOf(paint(source), "plain $inText text ");
    expect(literal).toContain("string.template.tsx");
    expect(literal).not.toContain("variable.parameter.capture.sweetener");
  });

  test("is a capture in a template literal's substitution", () => {
    expect(scopesOf(paint(source), "inSubstitution")).toContain(
      "variable.parameter.capture.sweetener",
    );
  });

  test("is not a capture in JSX text", () => {
    const children = scopesOf(paint(source), "plain $inChildren text");
    expect(children).toContain("meta.jsx.children.tsx");
    expect(children).not.toContain("variable.parameter.capture.sweetener");
  });

  test("is a capture in a JSX expression container", () => {
    const container = scopesOf(paint(source), "inContainer");
    expect(container).toContain("variable.parameter.capture.sweetener");
    expect(container).toContain("meta.embedded.expression.tsx");
  });

  test("is not a capture in a comment", () => {
    const tokens = paint(
      "export syntax twice:expr {\n" +
        "  // $value is the argument\n" +
        "  rule { twice($value:expr) } => { [$value, $value] }\n" +
        "}\n",
    );
    const comment = tokens.filter((token) =>
      token.scopes.includes("comment.line.double-slash.tsx"),
    );
    expect(comment.length).toBeGreaterThan(0);
    for (const token of comment)
      expect(token.scopes).not.toContain(
        "variable.parameter.capture.sweetener",
      );
  });
});
