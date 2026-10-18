import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

interface Expansion {
  readonly text: string;
  readonly diagnostics: readonly { readonly code: number }[];
}

/**
 * Expands a two-file project so the assertions below read as the macro author
 * and the caller would write them.
 */
function expand(macros: string, main: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-hygiene-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), main);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not expanded");
  return { text: generated, diagnostics: result.diagnostics };
}

describe("template-introduced bindings", () => {
  test("cannot capture a call-site identifier of the same spelling", () => {
    const { text, diagnostics } = expand(
      `export syntax addTo:expr {
         rule { addTo($value:expr) } => {
           ((subject) => subject + globalThis.Number($value))(100)
         }
       }`,
      `import { addTo } from "./macros.sts" for syntax;
       const subject = 5;
       export const result = addTo(subject);`,
    );
    expect(diagnostics).toEqual([]);
    // The parameter is renamed; the argument keeps the caller's binding, so the
    // sum is 105 rather than the 200 an unhygienic expansion would compute.
    expect(text).toContain("((subject_1) =>");
    expect(text).toContain("globalThis.Number(subject)");
  });

  test("keep their spelling when nothing else claims it", () => {
    const { text } = expand(
      `export syntax addTo:expr {
         rule { addTo($value:expr) } => { ((subject) => subject + $value)(1) }
       }`,
      `import { addTo } from "./macros.sts" for syntax;
       export const result = addTo(2);`,
    );
    expect(text).toContain("((subject) => subject");
    expect(text).not.toContain("subject_1");
  });

  test("stay distinct across separate invocations", () => {
    const { text } = expand(
      `export syntax twice:expr {
         rule { twice($value:expr) } => { ((held) => [held, held])($value) }
       }`,
      `import { twice } from "./macros.sts" for syntax;
       const held = 1;
       export const a = twice(held);
       export const b = twice(2);`,
    );
    expect(text).toContain("((held_1) => [held_1, held_1])(held)");
    expect(text).toContain("((held_2) => [held_2, held_2])(2)");
  });

  test("stay private through a nested expansion", () => {
    const { text, diagnostics } = expand(
      `export syntax inner:expr {
         rule { inner($value:expr) } => { ((shared) => shared + 1)($value) }
       }
       export syntax outer:expr {
         rule { outer($value:expr) } => {
           ((shared) => inner(shared) + shared)($value)
         }
       }`,
      `import { inner, outer } from "./macros.sts" for syntax;
       const shared = 10;
       export const composed = outer(shared);`,
    );
    expect(diagnostics).toEqual([]);
    // Each template gets its own name and the caller's binding survives both.
    expect(text).toContain("((shared_1) =>");
    expect(text).toContain("((shared_2) => shared_2 + 1)(shared_1)");
    expect(text).toContain(")(shared)");
  });

  test("rename statement and function declarations a template introduces", () => {
    const { text, diagnostics } = expand(
      `export syntax withLocals:stmt {
         rule { withLocals($value:expr); } => {
           function scale(factor: number): number { return factor * 2; }
           const scaled = scale($value);
           globalThis.console.log(scaled);
         }
       }`,
      `import { withLocals } from "./macros.sts" for syntax;
       export function run(): void {
         const scale = "call site scale";
         const scaled = "call site scaled";
         withLocals(3);
         globalThis.console.log(scale, scaled);
       }`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("function scale_1(");
    expect(text).toContain("const scaled_1 =");
    expect(text).toContain('const scale = "call site scale"');
  });

  test("expand a shorthand property whose value is renamed", () => {
    const { text, diagnostics } = expand(
      `export syntax pack:expr {
         rule { pack($value:expr) } => {
           ((item) => ({ item, total: item }))($value)
         }
       }`,
      `import { pack } from "./macros.sts" for syntax;
       const item = 7;
       export const packed = pack(item);`,
    );
    expect(diagnostics).toEqual([]);
    // The property must keep its own spelling even though the value moved.
    expect(text).toContain("({ item: item_1, total: item_1 })");
  });

  test("rename a destructured binder and leave its property name alone", () => {
    const { text, diagnostics } = expand(
      `export syntax firstOf:expr {
         rule { firstOf($value:expr) } => {
           (([head, ...tail]) => ({ head, tail }))($value)
         }
       }`,
      `import { firstOf } from "./macros.sts" for syntax;
       const head = 1;
       export const split = firstOf([head, 2, 3]);`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("([head_1, ...tail]) => ({ head: head_1, tail })");
  });

  test("rename an introduced type alias without touching the caller's", () => {
    const { text, diagnostics } = expand(
      `export syntax withTypes:item {
         rule { withTypes $name:binding; }
         bind $name in following as recursive value;
         => {
           type Payload = { readonly tag: string };
           const $name: Payload = { tag: "ok" };
         }
       }`,
      `import { withTypes } from "./macros.sts" for syntax;
       type Payload = { readonly other: number };
       withTypes marker;
       export const used: Payload = { other: 1 };
       export const tag = marker.tag;`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("type Payload_1 = ");
    expect(text).toContain("const marker: Payload_1");
    expect(text).toContain("export const used: Payload");
  });

  test("alias an introduced import instead of renaming the export", () => {
    const { text } = expand(
      `export syntax needsHelper:item {
         rule { needsHelper; } => {
           import { readFile } from "node:fs/promises";
           const loader = readFile;
           globalThis.console.log(loader);
         }
       }`,
      `import { needsHelper } from "./macros.sts" for syntax;
       const readFile = "call site readFile";
       needsHelper;
       export const kept = readFile;`,
    );
    // Renaming the specifier outright would import an export that is not there.
    expect(text).toContain('import { readFile as readFile_1 } from "node:fs');
    expect(text).toContain("const loader = readFile_1");
  });

  test("leave a parameter property alone so its member keeps the name", () => {
    const { text, diagnostics } = expand(
      `export syntax holder:item {
         rule { holder; } => {
           export class Holder {
             constructor(private readonly value: number) {}
             read(): number { return this.value; }
           }
         }
       }`,
      `import { holder } from "./macros.sts" for syntax;
       holder;
       export const size = new Holder(1).read();`,
    );
    expect(diagnostics).toEqual([]);
    // The parameter names a class member too, which `this.value` reaches.
    expect(text).toContain("constructor(private readonly value: number)");
    expect(text).toContain("this.value");
  });

  test("leave a name the template exports on the module surface", () => {
    const { text, diagnostics } = expand(
      `export syntax exported:item {
         rule { exported; } => { export const shared = 1; }
       }`,
      `import { exported } from "./macros.sts" for syntax;
       const shared = "call site shared";
       exported;
       export const kept = shared;`,
    );
    // Moving it would quietly publish a different export, so the clash stays
    // visible as an ordinary redeclaration error instead.
    expect(text).toContain("export const shared = 1");
    expect(diagnostics.some(({ code }) => code === 2451)).toBe(true);
  });

  test("leave a binder a contract publishes to the call site alone", () => {
    const { text, diagnostics } = expand(
      `import { useState } from "./runtime.js";
       export syntax state:stmt {
         rule { state $value:binding = $initial:expr; }
         bind $value in following as lexical value;
         bind #join($value, prefix: "set", casing: "upper-first") in following as lexical value;
         => {
           const [$value, #join($value, prefix: "set", casing: "upper-first")] =
             useState($initial);
         }
       }`,
      `import { state } from "./macros.sts" for syntax;
       export function useCounter(): number {
         state count = 0;
         setCount(1);
         return count;
       }`,
    );
    // The generated setter is the macro's public surface, so it must not move.
    expect(text).toContain("setCount");
    expect(text).not.toContain("setCount_1");
    expect(diagnostics.some(({ code }) => code === 2304)).toBe(false);
  });
});

describe("a binder a template declares through another macro", () => {
  test("binds what that macro's contract binds, renamed with them", () => {
    // The binder reaches `defv` as its capture and keeps `defv`'s use-site
    // scope, which nothing after the invocation carries. Renamed by the
    // scopes it was printed with, the declaration was renamed and the names
    // its contract binds were not, and the call site's `tmp` read them.
    const { text, diagnostics } = expand(
      `export syntax defv:item {
  rule { defv $name:binding = $v:expr; }
  bind $name in following as recursive value;
  => { const $name = $v; }
}
export syntax mk:item {
  rule { mk $out:binding; }
  bind $out in following as recursive value;
  => { defv tmp = 10; export const $out = tmp + 1; }
}
`,
      `import { defv, mk } from "./macros.sts" for syntax;
const tmp = 1;
mk x;
export const r = [tmp, x];
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("const tmp_1 = 10;");
    expect(text).toContain("export const x = tmp_1 + 1;");
    expect(text).toContain("export const r = [tmp, x];");
  });

  test("binds the names `#capture` publishes it to", () => {
    const { text, diagnostics } = expand(
      `export syntax pub:stmt {
  rule { pub $name:ident = $v:expr; } => { const #capture($name) = $v; }
}
export syntax outer:stmt {
  rule { outer $e:expr; } => { pub tmp = 10; globalThis.console.log(tmp, $e); }
}
`,
      `import { pub, outer } from "./macros.sts" for syntax;
export function f() {
  const tmp = 1;
  outer tmp;
  return tmp;
}
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("const tmp_1 = 10;");
    expect(text).toContain("globalThis.console.log(tmp_1, tmp);");
  });
});

/**
 * A name a template writes and does not bind is free in it, and never means a
 * local of the function its invocation stands in. Printed as written, a local
 * of that spelling captured it, and the expansion read the caller's value with
 * nothing said; the local is renamed instead.
 */
describe("a name a template writes free", () => {
  const useGlobal = `export syntax useGlobal:expr {
  rule { useGlobal($e:expr) } => { Math.abs($e) }
}
`;

  test("is not captured by a local of the caller's", () => {
    const { text, diagnostics } = expand(
      useGlobal,
      `import { useGlobal } from "./macros.sts" for syntax;
export function h() {
  const Math = { abs: (n: number) => n * 1000 };
  return [useGlobal(-1), Math.abs(2)];
}
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("const Math_1 = { abs: (n: number) => n * 1000 };");
    expect(text).toContain("return [Math.abs(-1), Math_1.abs(2)];");
  });

  test("is not captured by a parameter, which keeps its own uses", () => {
    const { text, diagnostics } = expand(
      useGlobal,
      `import { useGlobal } from "./macros.sts" for syntax;
export function h(Math: { abs(n: number): number }) {
  return useGlobal(Math.abs(-1));
}
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain(
      "export function h(Math_1: { abs(n: number): number }) {",
    );
    expect(text).toContain("return Math.abs(Math_1.abs(-1));");
  });

  test("leaves a local no template name meets as written", () => {
    const { text, diagnostics } = expand(
      useGlobal,
      `import { useGlobal } from "./macros.sts" for syntax;
export function h() { const Math = 1; return Math; }
export const g = useGlobal(-1);
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("export function h() { const Math = 1; return Math; }");
    expect(text).toContain("export const g = Math.abs(-1);");
  });

  test("still means what the module using it declares at its top", () => {
    // The template's own module declares no `add`, so it means the one the
    // module using it declares.
    const { text, diagnostics } = expand(
      `export syntax sum:expr { rule { sum($a:expr, $b:expr) } => { add($a, $b) } }\n`,
      `import { sum } from "./macros.sts" for syntax;
function add(a: number, b: number) { return a + b; }
export const s = sum(1, 2);
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain("function add(a: number, b: number)");
    expect(text).toContain("export const s = add(1, 2);");
  });
});

/**
 * A template's tokens all carry one scope set, so a binder it writes and a
 * global of the same spelling it uses beside the binder are one name by
 * their scopes alone. Renamed together, the global was renamed out of
 * existence (#1). A binder binds where TypeScript scopes it, and only there
 * is its name renamed.
 */
describe("a binder a template writes beside a global of its spelling", () => {
  const bareGlobalUse = `export syntax bareGlobalUse:expr {
  rule { bareGlobalUse($input:expr) } => {
    [((JSON) => JSON)(1), JSON.stringify($input)]
  }
}
`;

  test("is renamed without the global", () => {
    const { text, diagnostics } = expand(
      bareGlobalUse,
      `import { bareGlobalUse } from "./macros.sts" for syntax;
const JSON = { stringify: (v: unknown) => String(v) };
export const a = bareGlobalUse(1);
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toContain(
      "export const a = [((JSON_1) => JSON_1)(1), JSON.stringify(1)];",
    );
  });

  test("leaves the global the template means past a caller's local", () => {
    const { text, diagnostics } = expand(
      bareGlobalUse,
      `import { bareGlobalUse } from "./macros.sts" for syntax;
export function h() {
  const JSON = { stringify: (v: unknown) => String(v) };
  return [bareGlobalUse(1), JSON.stringify(2)];
}
`,
    );
    expect(diagnostics).toEqual([]);
    expect(text).toMatch(
      /\[\(\((JSON_\d+)\) => \1\)\(1\), JSON\.stringify\(1\)\]/u,
    );
    expect(text).toContain("JSON_1.stringify(2)");
  });
});
