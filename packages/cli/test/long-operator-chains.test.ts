import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
  runConfiguredProjectCommand,
} from "../src/index.js";

/**
 * A chain of operators as long as an author or a generator writes it.
 *
 * The parser read each operand of a right-associative chain, each
 * conditional's alternate and each prefix operator's operand by reading the
 * rest of the chain, and held every operator as a node holding the one
 * before it. Fifty thousand of them overflowed the call stack in the
 * enforester, a capture holding them met the nesting limit, normalization
 * flattened the tree a level at a time, and the walk read the whole statement
 * back from every `=`, `[` and brace in it. A chain of one level is now one
 * node, and each of those reads is bounded by the chain's own levels.
 */

const macros = `
export syntax id:expr { rule { id($e:expr) } => { $e } }
export syntax pow:expr { rule { pow($a:expr, $b:expr, $c:expr) } => { $a ** $b ** $c } }
export syntax set3:expr { rule { set3($a:expr, $b:expr, $c:expr) } => { $a = $b = $c } }
export syntax pick:expr {
  rule { pick($a:expr, $b:expr, $c:expr, $d:expr, $e:expr) } => { $a ? $b : $c ? $d : $e }
}
export syntax notnot:expr { rule { notnot($v:expr) } => { !!$v } }
export syntax negneg:expr { rule { negneg($v:expr) } => { - -$v } }
`;

function project(main: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-long-chains-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { id, pow, set3, pick, notnot, negneg } from "./macros.sts" for syntax;\n${main}`,
  );
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  return configPath;
}

const terms = (separator: string, count = 50_000) =>
  Array.from({ length: count }, (_, at) => `v${String(at % 10)}`).join(
    separator,
  );

const declared =
  "declare let v0: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number, v7: number, v8: number, v9: number;\n";

/**
 * Expanded without TypeScript's checker, which reads a chain this long in
 * time that grows with its square on its own: the subject here is that the
 * expansion reads, walks and prints it.
 */
describe("fifty thousand terms of one chain", () => {
  test.each([
    ["a sum", `export const s = ${terms(" + ")};`],
    ["a sum handed to a macro", `export const s = id(${terms(" + ")});`],
    [
      "a sum of products",
      `export const s = ${terms(" + ").replaceAll("v3", "v3 * v4")};`,
    ],
    ["powers", `export const s = ${terms(" ** ")};`],
    ["assignments", `${terms(" = ")};`],
    [
      "conditionals",
      `export const s = ${Array.from({ length: 50_000 }, (_, at) => `v${String(at % 10)} ? ${String(at)} : `).join("")}0;`,
    ],
    ["negations", `export const s = ${"!".repeat(50_000)}v0;`],
    [
      "indexes",
      `declare const o: any;\nexport const s = o${"[0]".repeat(50_000)};`,
    ],
    [
      "a union of object types",
      `export type T = ${Array.from({ length: 50_000 }, (_, at) => `{ k: ${String(at)} }`).join(" | ")};`,
    ],
  ])("of %s expands as written", (_, source) => {
    const main = `${declared}${source}\n`;
    const output = createDefaultProjectExpansionProvider().expandProject(
      loadSweetProject(project(main)),
    );
    expect(output.diagnostics).toEqual([]);
    const generated = output.files.find(({ fileName }) =>
      fileName.endsWith("main.ts"),
    )?.generated.text;
    expect(generated?.trim()).toBe(
      main
        .replace(/^export const s = id\((.*)\);$/mu, "export const s = $1;")
        .trim(),
    );
  });
});

/**
 * A chain a template writes is printed from the node the parser built for
 * it, so the printer reads a chain of either associativity, a conditional
 * holding the conditionals in its alternates, and a run of prefix operators,
 * as the one node each now is. TypeScript checks each result.
 */
describe("a chain a template writes", () => {
  test("is printed with the parentheses its operands need and no more", () => {
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath:
        project(`declare let x: number, y: number, z: number, p: boolean, q: boolean;
export const a = pow(-x, y, z);
export const b = pow(x, y + 1, -z);
export const c = set3(x, y, z + 1);
export const d = pick(p, 1, p || q, 2, x = 3);
export const e = pick(p = q, 1, q, 2, 3);
export const f = notnot(x + y);
export const g = negneg(-x);
`),
      writeThrough: false,
    });
    expect(result.diagnostics).toEqual([]);
    const generated = result.virtualFiles.find(({ fileName }) =>
      fileName.endsWith("main.ts"),
    )?.generated.text;
    for (const printed of [
      "export const a = (-x) ** y ** z;",
      "export const b = x ** (y + 1) ** -z;",
      "export const c = x = y = z + 1;",
      "export const d = p ? 1 : p || q ? 2 : x = 3;",
      "export const e = (p = q) ? 1 : q ? 2 : 3;",
      "export const f = !!(x + y);",
      "export const g = - -(-x);",
    ])
      expect(generated).toContain(printed);
  });
});
