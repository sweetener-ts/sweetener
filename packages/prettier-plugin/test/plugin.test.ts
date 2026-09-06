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

    // The item-macro prefix survives, no trailing comma is introduced, and
    // the string is exactly as written, quotes included.
    expect(formatted).toContain("wrapped const example");
    expect(formatted).toContain("[1, 2]");
    expect(formatted).not.toContain(",\n}");
    expect(formatted).toContain("{ single: 'quoted'");
  });

  test("keeps a string's quotes whatever the project asks for", async () => {
    const source = `import { wrapped } from "./macros.sts" for syntax;

wrapped const example = { single: 'quoted' };
`;
    for (const singleQuote of [true, false])
      expect(
        await formatSweetenerWithPrettier(source, {
          filepath: "main.sts",
          singleQuote,
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
 * Layout is normalized; the tokens are left as written.
 *
 * Semicolons and quotes are real tokens to a macro matcher, so Prettier's
 * normalizing of them cannot be applied — the implicit-return macro below
 * shows what it would cost. Counting them as changed tokens, though, meant a
 * file written without semicolons, or holding a single-quoted string, failed
 * the check entirely and came back unformatted with nothing said about it. The
 * file is printed again with the other choice instead, so its own style is
 * what survives and everything around it still gets formatted.
 */
describe("formatting a file written in its own style", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["a statement with no semicolon", "const   a=1\n", "const a = 1\n"],
    [
      "several statements with no semicolons",
      "const   a=1\nconst   b=2\n",
      "const a = 1\nconst b = 2\n",
    ],
    [
      "a function body with no semicolons",
      "function f(  a:number,b:number ){return a+b}\n",
      "function f(a: number, b: number) {\n  return a + b\n}\n",
    ],
    ["a single-quoted string", "const   a='x'\n", "const a = 'x'\n"],
    ["a double-quoted string", 'const   a="x"\n', 'const a = "x"\n'],
    [
      "the import prologue of the default Vite template",
      "import { useState } from 'react'\nimport './App.css'\n",
      "import { useState } from 'react'\nimport './App.css'\n",
    ],
  ];

  for (const [description, source, expected] of cases)
    test(`formats ${description}`, async () => {
      expect(await formatSweetenerWithPrettier(source)).toBe(expected);
    });

  test("keeps quotes that would otherwise need escaping", async () => {
    expect(await formatSweetenerWithPrettier("const   a='say \"hi\"'\n")).toBe(
      "const a = 'say \"hi\"'\n",
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
        "export const pair: number[] = twice(21)",
        "function f(a: number) {",
        "  return twice(a)",
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

  test("leaves a string's quotes as the source wrote them", async () => {
    // `singleQuote` cannot be applied: the quote is part of the token's
    // spelling, and a rule may select on how a token is spelled.
    expect(
      await formatSweetenerWithPrettier('const   a="x"\n', {
        singleQuote: true,
      }),
    ).toBe('const a = "x"\n');
    expect(
      await formatSweetenerWithPrettier("const   a='x'\n", {
        singleQuote: false,
      }),
    ).toBe("const a = 'x'\n");
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
        `import { twice } from './macros.sts' for syntax`,
        "export const pair: number[] = twice(21)",
        "function f(a: number) {",
        "  return twice(a)",
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
    expect(formatted).toContain("const kind = typeof 1");
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
      expect(formatted).toMatch(/const (?:x = 1|kind = typeof 1);?/u);
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

/**
 * A macro can match on a semicolon not being there.
 *
 * The implicit-return example returns a function's final expression, and what
 * tells that from an expression statement is the absence of a `;`. Prettier
 * adds one under its default settings, which changes what the program means —
 * so a formatting that does it has to be refused, however the project is
 * configured. Treating statement semicolons as layout, which is the obvious
 * way to make semicolon-free files format, breaks exactly this.
 */
describe("formatting that would change what a macro matches", () => {
  const implicitReturn = [
    `import { function } from "./macros.sts" for syntax shadows core;`,
    "",
    "export const calculate = function(value: number) {",
    "  const doubled = value * 2;",
    "  doubled + 1",
    "};",
    "",
  ].join("\n");

  test("is refused rather than applied", async () => {
    const formatted = await formatSweetenerWithPrettier(implicitReturn);
    expect(formatted).toContain("doubled + 1\n");
    expect(formatted).not.toContain("doubled + 1;");
  });

  test("is still refused when the project asks for semicolons", async () => {
    const formatted = await formatSweetenerWithPrettier(implicitReturn, {
      semi: true,
    });
    expect(formatted).not.toContain("doubled + 1;");
  });
});

/**
 * The stand-in for a compile-time import is written as an import-attributes
 * clause, and Prettier prints it under the project's own settings: `semi:
 * false` drops its semicolon, `singleQuote` rewrites its quotes. Restoration
 * searched for the text as written, found nothing, and returned the file
 * untouched — which is every file with a compile-time import in it, in any
 * project configured either way.
 */
describe("a compile-time import under the project's own Prettier settings", () => {
  const source = [
    "import {twice, (|>)} from './macros.sts' for syntax",
    "const   x=twice(21)",
    "",
  ].join("\n");

  const settings: readonly (readonly [
    string,
    { semi?: boolean; singleQuote?: boolean },
  ])[] = [
    ["defaults", {}],
    ["semi: false", { semi: false }],
    ["singleQuote", { singleQuote: true }],
    ["both", { semi: false, singleQuote: true }],
  ];

  for (const [description, options] of settings)
    test(`formats with ${description}`, async () => {
      const formatted = await formatSweetenerWithPrettier(source, options);
      expect(formatted).toContain("for syntax");
      expect(formatted).toContain("(|>)");
      // The statement below the import keeps its own line.
      expect(formatted).toMatch(/for syntax\n/u);
      // The source has no semicolon, so neither does the result, whatever
      // the project asked for: the style the file is written in is what a
      // macro may be matching on.
      expect(formatted).toMatch(/const x = twice\(21\)\n/u);
      expect(await formatSweetenerWithPrettier(formatted, options)).toBe(
        formatted,
      );
    });
});
