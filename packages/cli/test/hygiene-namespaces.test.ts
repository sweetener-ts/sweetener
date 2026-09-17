import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Hygiene has to reach every kind of name a macro can introduce, and has to
 * decide what an `export { name }` pins by resolving it rather than by
 * matching its spelling.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-hygiene-names-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  return {
    generated:
      expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text ?? "",
    messages: expanded.diagnostics.map(
      ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
    ),
  };
}

describe("what an export clause pins", () => {
  const hold =
    "export syntax hold:item { rule { hold($value:expr) } => { const tmp = $value; } }";

  test("a call site exporting its own name does not pin an introduced one", () => {
    // Pinned by spelling, `export { tmp }` at the call site would hold a
    // macro-introduced `tmp` in place too, leaving two `const tmp` in the
    // output and a redeclaration error where hygiene should rename one.
    const { generated, messages } = run(
      hold,
      'import { hold } from "./macros.sts" for syntax;\n' +
        "const tmp = 99;\n" +
        "hold(1)\n" +
        "export { tmp };\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("const tmp = 99");
    expect(generated).toContain("const tmp_1 =");
    expect(generated).toContain("export { tmp }");
  });

  test("a macro exporting the name it introduces still keeps it", () => {
    const { generated, messages } = run(
      "export syntax publish:item { rule { publish($value:expr) } => { const shared = $value;\nexport { shared }; } }",
      'import { publish } from "./macros.sts" for syntax;\npublish(7)\n',
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("const shared =");
    expect(generated).not.toContain("shared_1");
  });
});

describe("labels", () => {
  const loop =
    "export syntax repeat:stmt { rule { repeat($body:expr); } => { outer: for (;;) { $body; break outer; } } }";

  test("an introduced label does not collide with one at the call site", () => {
    // A label is a binding, not a property, and has to be renamed: otherwise
    // there is a duplicate label, and a `break` that leaves whichever loop the
    // collision leaves standing.
    const { generated, messages } = run(
      loop,
      'import { repeat } from "./macros.sts" for syntax;\n' +
        "export function f() { outer: for (;;) { repeat(1); break outer; } }\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("outer_1:");
    expect(generated).toContain("break outer_1");
    // The call site's own break still leaves the call site's own loop.
    expect(generated).toContain("break outer;");
  });

  test("a label the call site writes is left alone", () => {
    const { generated, messages } = run(
      "export syntax noop:stmt { rule { noop(); } => { ; } }",
      'import { noop } from "./macros.sts" for syntax;\n' +
        "export function f() { outer: for (;;) { noop(); break outer; } }\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("outer:");
    expect(generated).not.toContain("outer_1");
  });
});

describe("parameter properties", () => {
  const box = `
export syntax box:item {
  rule { box($value:expr) } => {
    export class Box {
      total: number;
      constructor(private held: number) { this.total = held + ($value); }
    }
  }
}
`;

  test("an introduced parameter property does not capture the call site", () => {
    // A parameter property declares a parameter and a member under the one
    // spelling, and `this.name` reaches the member. Leaving it unrenamed for
    // that reason lets it capture a call-site name of the same spelling: the
    // captured `held` would read the constructor's parameter instead of the
    // module's own.
    const { generated, messages } = run(
      box,
      'import { box } from "./macros.sts" for syntax;\n' +
        "const held = 5;\n" +
        "box(held)\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("private held_1: number");
    expect(generated).toContain("held_1 + (held)");
  });

  test("this. follows the parameter property it names", () => {
    const { generated, messages } = run(
      `
export syntax box:item {
  rule { box($value:expr) } => {
    export class Box {
      constructor(private held: number) {}
      read() { return this.held + ($value); }
    }
  }
}
`,
      'import { box } from "./macros.sts" for syntax;\n' +
        "const held = 5;\n" +
        "box(held)\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("private held_1: number");
    expect(generated).toContain("this.held_1");
  });

  test("a property access naming no parameter property stays put", () => {
    // A rename cannot follow a member declared anywhere else, so it must not
    // start one.
    const { generated, messages } = run(
      `
export syntax box:item {
  rule { box($value:expr) } => {
    export class Box {
      held = 1;
      read() { return this.held + ($value); }
    }
  }
}
`,
      'import { box } from "./macros.sts" for syntax;\n' +
        "const held = 5;\n" +
        "box(held)\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("this.held");
    expect(generated).not.toContain("this.held_1");
  });
});
