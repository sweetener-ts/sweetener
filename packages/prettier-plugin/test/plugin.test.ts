import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";
import { describe, expect, test } from "vitest";
import plugin, {
  formatSweetener,
  formatSweetenerWithPrettier,
} from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Sweetener Prettier plugin", () => {
  test("registers and formats .sts files through Prettier", async () => {
    const source = `export syntax unless:stmt {
rule { unless ($condition:expr) $body:stmt } => {
if (!($condition)) $body
}
}
`;
    const formatted = await format(source, {
      filepath: "macros.sts",
      plugins: [plugin],
    });

    expect(formatted).toBe(`export syntax unless:stmt {
  rule { unless ($condition:expr) $body:stmt } => {
    if (!($condition)) $body
  }
}
`);
  });

  test("is idempotent across the language-tour corpus", async () => {
    const tourRoot = resolve(repositoryRoot, "examples/language-tour");
    const names = (await readdir(tourRoot, { recursive: true }))
      .filter((name) => /\.stsx?$/u.test(name))
      .sort();

    for (const name of names) {
      const source = await readFile(resolve(tourRoot, name), "utf8");
      const once = await format(source, {
        filepath: name,
        plugins: [plugin],
      });
      const twice = await format(once, {
        filepath: name,
        plugins: [plugin],
      });
      expect(twice, name).toBe(once);
    }
  });

  test("preserves whitespace with runtime meaning", () => {
    const source =
      "const template = `first\\n  second`;\nconst view = <pre>  exact  </pre>;\n";
    expect(formatSweetener(source, { filepath: "view.stsx" })).toBe(source);
  });

  test("does not indent otherwise blank lines", () => {
    const source = `export syntax class Example {
  fields {
    name: binding;
  }

  rule { $name:binding }
}
`;

    expect(formatSweetener(source, { filepath: "macros.sts" })).toBe(source);
  });

  test("formats TypeScript and JSX inside an imported item macro", async () => {
    const source = `import { memoized } from "./fine-jsx.stsx" for syntax;

interface FixtureProps { readonly cond?: boolean; readonly id: number; }

memoized function Component({ cond = false, id }: FixtureProps) {
  return (<><div className={identity(styles.a, id !== null ? styles.b : {})}></div>{cond === false && (<div className={identity(styles.c, DISPLAY ? styles.d : {})} />)}</>);
}
`;
    const formatted = await formatSweetenerWithPrettier(source, {
      filepath: "main.stsx",
    });

    expect(formatted).toContain(
      `import { memoized } from "./fine-jsx.stsx" for syntax;`,
    );
    expect(formatted).toContain(`memoized function Component(`);
    expect(formatted).toContain("cond = false,\n  id\n");
    expect(formatted).not.toContain("id,\n}: FixtureProps");
    expect(formatted).toContain("return (\n    <>");
    expect(formatted).toContain("{cond === false && (");
    await expect(
      formatSweetenerWithPrettier(formatted, { filepath: "main.stsx" }),
    ).resolves.toBe(formatted);
  });

  test("never changes the token stream seen by macro matchers", async () => {
    const source = `import { wrapped } from "./macros.sts" for syntax;

wrapped const example = { single: 'quoted', trailing: [1, 2] };
`;
    const formatted = await formatSweetenerWithPrettier(source, {
      filepath: "main.sts",
    });

    // The item-macro prefix survives, no trailing comma is introduced, and the
    // string's contents are exactly what they were. Which quote encloses it is
    // the project's setting, not something a macro matcher should hinge on:
    // treating a normalized quote as a changed token left every file holding a
    // single-quoted string unformatted, and said nothing about it.
    expect(formatted).toContain("wrapped const example");
    expect(formatted).toContain("[1, 2]");
    expect(formatted).not.toContain(",\n}");
    expect(formatted).toContain("quoted");
  });

  test("keeps the quotes a project asks for", async () => {
    const source = `import { wrapped } from "./macros.sts" for syntax;

wrapped const example = { single: 'quoted' };
`;
    expect(
      await formatSweetenerWithPrettier(source, {
        filepath: "main.sts",
        singleQuote: true,
      }),
    ).toContain("{ single: 'quoted' }");
  });

  test("rejects structurally malformed input", () => {
    expect(() =>
      formatSweetener("syntax broken {", { filepath: "bad.sts" }),
    ).toThrow(/malformed source/u);
  });
});

/**
 * The guard that keeps Prettier from changing tokens a macro can match used to
 * count two things it should not have. Prettier inserts a semicolon where the
 * source relied on automatic insertion, and normalizes quotes to whatever the
 * project configured; either one made the guard reject the whole formatting
 * and hand the file back exactly as it came in — silently, so `--check`
 * reported it as already correct.
 */
describe("formatting source that omits semicolons or uses single quotes", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["a statement with no semicolon", "const   a=1\n", "const a = 1;\n"],
    [
      "several statements with no semicolons",
      "const   a=1\nconst   b=2\n",
      "const a = 1;\nconst b = 2;\n",
    ],
    [
      "a function body with no semicolons",
      "function f(  a:number,b:number ){return a+b}\n",
      "function f(a: number, b: number) {\n  return a + b;\n}\n",
    ],
    ["a single-quoted string", "const   a='x'\n", 'const a = "x";\n'],
    [
      "the import prologue of the default Vite template",
      "import { useState } from 'react'\nimport './App.css'\n",
      'import { useState } from "react";\nimport "./App.css";\n',
    ],
  ];

  for (const [description, source, expected] of cases)
    test(`formats ${description}`, async () => {
      expect(await formatSweetenerWithPrettier(source)).toBe(expected);
    });

  test("keeps quotes that would otherwise need escaping", async () => {
    expect(await formatSweetenerWithPrettier("const   a='say \"hi\"'\n")).toBe(
      "const a = 'say \"hi\"';\n",
    );
  });

  test("expands macro invocations' surroundings all the same", async () => {
    const source = [
      'import {twice} from "./macros.sts" for syntax;',
      "export const   pair:number[]=twice(21)",
      "function f(  a:number ){return twice(a)}",
      "",
    ].join("\n");
    expect(await formatSweetenerWithPrettier(source)).toBe(
      [
        'import { twice } from "./macros.sts" for syntax;',
        "export const pair: number[] = twice(21);",
        "function f(a: number) {",
        "  return twice(a);",
        "}",
        "",
      ].join("\n"),
    );
  });
});

/**
 * The project's own Prettier settings have to reach the inner format call.
 * Only `trailingComma` is pinned; everything else was dropped, so a `.sts` was
 * formatted to Prettier's defaults no matter what the repository configured.
 */
describe("project Prettier options", () => {
  test("honours semi: false", async () => {
    expect(
      await formatSweetenerWithPrettier("const   a=1\n", { semi: false }),
    ).toBe("const a = 1\n");
  });

  test("honours singleQuote", async () => {
    expect(
      await formatSweetenerWithPrettier('const   a="x"\n', {
        singleQuote: true,
      }),
    ).toBe("const a = 'x';\n");
  });

  test("honours printWidth", async () => {
    const source = "const value = someFunction(alpha, beta, gamma, delta)\n";
    expect(
      await formatSweetenerWithPrettier(source, { printWidth: 30 }),
    ).toContain("\n");
  });
});

/**
 * A compile-time import ends at a line break, so the formatter must too.
 *
 * The mask that stands in for the import while Prettier formats the file
 * looked only for the import's semicolon. A `for syntax` import written
 * without one — which the compiler accepts, as it does for any statement — was
 * therefore never masked, Prettier could not parse `for syntax`, and the whole
 * file came back unformatted with nothing said about it.
 */
describe("a compile-time import with no semicolon", () => {
  test("is masked, so the file around it still formats", async () => {
    const source = [
      "import {twice} from './macros.sts' for syntax",
      "export const   pair:number[]=twice(21)",
      "function f(  a:number ){return twice(a)}",
      "",
    ].join("\n");
    expect(await formatSweetenerWithPrettier(source)).toBe(
      [
        `import { twice } from "./macros.sts" for syntax`,
        "export const pair: number[] = twice(21);",
        "function f(a: number) {",
        "  return twice(a);",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("keeps shadows core intact", async () => {
    const source = [
      "import {typeof} from './forms.sts' for syntax shadows core",
      "const   kind=typeof 1",
      "",
    ].join("\n");
    const formatted = await formatSweetenerWithPrettier(source);
    expect(formatted).toContain("for syntax shadows core");
    expect(formatted).toContain("const kind = typeof 1;");
  });
});

/**
 * Sweetener imports a macro by whatever it is called, and two of the things it
 * can be called are not identifiers: an operator, `(|>)`, and a core form
 * being shadowed, `typeof`. Prettier parses what is left after the
 * compile-time tail is masked, and neither is TypeScript, so it failed to
 * parse and returned the file untouched — for the pipeline operator that opens
 * the README, among others.
 */
describe("importing a macro that is not named by an identifier", () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      "an operator",
      `import { (|>) } from "./ops.sts" for syntax;\nconst   x=1;\n`,
    ],
    [
      "a shadowed core form",
      `import { typeof } from "./forms.sts" for syntax shadows core;\nconst   kind=typeof 1;\n`,
    ],
    [
      "an operator beside an ordinary macro",
      `import { twice, (|>) } from "./ops.sts" for syntax;\nconst   x=1;\n`,
    ],
  ];

  for (const [description, source] of cases)
    test(`formats around ${description}`, async () => {
      const formatted = await formatSweetenerWithPrettier(source);
      // The file formats, and the import comes back exactly as written.
      expect(formatted).toContain(source.split("\n")[0]);
      expect(formatted).toMatch(/const (?:x = 1|kind = typeof 1);/u);
      expect(await formatSweetenerWithPrettier(formatted)).toBe(formatted);
    });

  test("does not let a stand-in change where the import wraps", async () => {
    // The stand-ins occupy the width of what they replace while Prettier
    // decides on line breaks; long ones wrapped imports that fit.
    expect(
      await formatSweetenerWithPrettier(
        `import { twice, (|>) } from "./ops.sts" for syntax;\nconst   x=1;\n`,
      ),
    ).toContain(`import { twice, (|>) } from "./ops.sts" for syntax;`);
  });
});
