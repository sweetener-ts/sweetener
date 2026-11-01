import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A JSX expression container holds one expression. Walked as the members of
 * an object literal -- what a brace in the expression space otherwise is --
 * the expression inside was never read, so an operator written there was
 * never offered its operands and was reported as left unexpanded.
 */
test("an operator expands inside JSX expression containers", () => {
  const directory = mkdtempSync(join(tmpdir(), "sweet-jsx-container-"));
  writeFileSync(
    join(directory, "macros.sts"),
    `export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 40;
  rule { $value:expr |> $callee:ident } => { $callee($value) }
}
`,
  );
  writeFileSync(
    join(directory, "view.stsx"),
    `import { (|>) } from "./macros.sts" for syntax;
declare global { namespace JSX { interface IntrinsicElements { b: { title?: string; a?: number; children?: unknown } } } }
declare function h(...args: unknown[]): unknown;
const trim = (value: string) => value.trim();
const props = { a: 1 };
export const attribute = <b title={"x" |> trim} {...props} />;
export const child = <b>{/* note */}text {"y" |> trim} more</b>;
export const spread = <b>{...["z" |> trim]}</b>;
export const object = <b title={{ k: "w" |> trim }.k} />;
`,
  );
  const config = join(directory, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        jsx: "react",
        jsxFactory: "h",
      },
      files: ["macros.sts", "view.stsx"],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: config,
    writeThrough: false,
  });
  expect(result.diagnostics).toEqual([]);
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("view.tsx"),
  )?.generated.text;
  expect(generated).toContain(`<b title={trim("x")} {...props} />`);
  expect(generated).toContain(`<b>{/* note */}text {trim("y")} more</b>`);
  expect(generated).toContain(`<b>{...[trim("z")]}</b>`);
  expect(generated).toContain(`<b title={{ k: trim("w") }.k} />`);
});
