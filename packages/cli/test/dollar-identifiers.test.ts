import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A name that begins with `$` is written `$$` in a template or a pattern.
 *
 * `$name` is a capture there, so a template needs some other way to write an
 * ordinary identifier that begins with `$` -- Drizzle's `$inferSelect`,
 * Svelte's `$state` -- or `typeof $table.$inferSelect` is refused as a
 * reference to an unknown capture. `$$` stands for one `$`, the way `$$`
 * escapes a dollar in a Rust macro.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-dollar-names-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, target: "ES2022" },
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
    messages: expanded.diagnostics.map(({ messageText }) =>
      String(messageText),
    ),
  };
}

describe("names that begin with $", () => {
  test("a template writes one as $$", () => {
    const { generated, messages } = run(
      `
export syntax rowOf:type {
  rule { rowOf($table:ident) } => { typeof $table.$$inferSelect }
}
export syntax state:expr {
  rule { state($value:expr) } => { $$state($value) }
}
`,
      `import { rowOf, state } from "./macros.sts" for syntax;
declare const users: { $inferSelect: { id: number } };
declare function $state<T>(value: T): T;
export type User = rowOf(users);
export const counter = state(0);
export const row: User = { id: 1 };
`,
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("typeof users.$inferSelect");
    expect(generated).toContain("$state(");
  });

  test("a pattern matches one as $$", () => {
    const { generated, messages } = run(
      `
export syntax column:expr {
  rule { column($name:ident.$$type<$kind:type>()) } => { [#text($name), #text($kind)] }
  rule { column($name:ident) } => { [#text($name)] }
}
`,
      `import { column } from "./macros.sts" for syntax;
export const typed = column(age.$type<number>());
`,
    );
    expect(messages).toEqual([]);
    expect(generated).toContain('["age", "number"]');
  });

  test("$$$ writes a name that begins with $$", () => {
    const { generated, messages } = run(
      `
export syntax both:expr {
  rule { both() } => { $$$ + $$$value }
}
`,
      `import { both } from "./macros.sts" for syntax;
declare const $$: number;
declare const $$value: number;
export const sum = both();
`,
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("$$ + $$value");
  });

  test("a single $name that names no capture is still reported", () => {
    const { messages } = run(
      `
export syntax typo:expr {
  rule { typo($value:expr) } => { $valeu }
}
`,
      `import { typo } from "./macros.sts" for syntax;
export const value = typo(1);
`,
    );
    expect(messages.join("\n")).toContain("unknown capture $valeu");
  });
});
