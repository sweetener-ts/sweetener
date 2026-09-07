import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IntegrationFixture {
  readonly root: string;
  readonly entry: string;
  readonly macros: string;
  readonly config: string;
}

export function integrationFixture(
  host: string,
  options: {
    readonly entryExtension?: ".sts" | ".ts" | undefined;
    readonly directive?: boolean | undefined;
    /**
     * Whether the entry carries a type annotation. On by default.
     *
     * It used to be off, and every host but Vite and Bun was verified against
     * `export const answer = duplicate(21);` — source with nothing in it a
     * JavaScript parser would refuse. Expansion emits TypeScript, so those
     * hosts were failing on the first annotated declaration a real project
     * would write, and the suite could not see it.
     */
    readonly typed?: boolean | undefined;
  } = {},
): IntegrationFixture {
  const root = mkdtempSync(join(tmpdir(), `sweet-${host}-`));
  const entryName = `main${options.entryExtension ?? ".sts"}`;
  const entry = join(root, entryName);
  const macros = join(root, "macros.sts");
  const config = join(root, "tsconfig.json");
  writeFileSync(
    macros,
    `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, $value] } }\n`,
  );
  writeFileSync(
    entry,
    `${options.directive === true ? '"use sweetener";\n' : ""}import { duplicate } from "./macros.sts" for syntax;\n${options.typed === false ? "export const answer = duplicate(21);\n" : "export interface Answer { readonly values: number[] }\nexport const answer: Answer = { values: duplicate(21) };\n"}`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022" },
      files: ["macros.sts", entryName],
    }),
  );
  return { root, entry, macros, config };
}

/**
 * The fixture macro expands `duplicate(21)` into `[21, 21]`, so a host that
 * emitted the captured value once — passing the argument through without
 * running the rule — is as wrong as one that emitted nothing. Look for the
 * whole expansion, however the host spaced or minified it.
 */
const expansion = /\[\s*21\s*,\s*21\s*\]/u;

export function expectExpanded(code: string): void {
  if (!expansion.test(code))
    throw new Error("bundle omitted the expanded value");
  if (code.includes("duplicate") || code.includes("for syntax"))
    throw new Error("bundle retained compile-time Sweetener syntax");
}
