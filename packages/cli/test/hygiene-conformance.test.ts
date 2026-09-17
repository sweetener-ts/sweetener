import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

const fixture = resolve("fixtures/conformance/hygiene/semantic-suite");

/**
 * The hygiene conformance fixture, expanded.
 *
 * Asserting that the fixture's scenario names match a list in the test says
 * nothing about hygiene on its own, and nothing at all if `input.sts` calls
 * macros its `macros.sts` never defines. This runs the fixture and reads what
 * comes out.
 */
function expandFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-conformance-"));
  for (const file of ["runtime.ts", "macros.sts", "input.sts"])
    cpSync(join(fixture, file), join(directory, file));
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
      sweet: { macroExtensions: [".sts"] },
      files: ["runtime.ts", "macros.sts", "input.sts"],
    }),
    "utf8",
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  expect(
    result.diagnostics.map(({ messageText }) => String(messageText)),
  ).toEqual([]);
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("input.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("input.sts was not expanded");
  return generated;
}

describe("hygiene conformance", () => {
  test("renames a binding the macro introduced, against the call site's", () => {
    // The macro's own `tmp` and the call site's `tmp` are both in the result,
    // and they are not the same binding.
    const generated = expandFixture();
    expect(generated).toMatch(/tmp_\d+/u);
    expect(generated).toContain("const tmp = 100;");
    const [, introduced] = /\(\((tmp_\d+): number\)/u.exec(generated) ?? [];
    expect(introduced).toBeDefined();
    // The captured argument stays the call site's `tmp`, not the renamed one.
    expect(generated).toContain(`${introduced!} + (tmp)`);
  });

  test("resolves a name in a template where the macro was defined", () => {
    // `describe` expands to the `helper` its own module imports, while the
    // call site's `helper` of the same spelling is left for the call site.
    const generated = expandFixture();
    const [, moduleHelper] =
      /import \{ helper as (helper_\d+) \}/u.exec(generated) ?? [];
    expect(moduleHelper).toBeDefined();
    expect(generated).toContain(
      `const described: string = ${moduleHelper!}(7)`,
    );
    expect(generated).toContain("const callSite: string = helper(7)");
  });

  test("keeps a parameter the macro introduced out of the call site", () => {
    const generated = expandFixture();
    expect(generated).toContain("(item: number)");
    // Nothing named `item` escapes into the surrounding module.
    expect(generated).not.toMatch(/^const item/mu);
  });

  test("the fixture's scenarios are the ones these tests check", () => {
    const declared = JSON.parse(
      readFileSync(join(fixture, "expected.bindings.json"), "utf8"),
    ) as { readonly scenarios: readonly string[] };
    expect(declared.scenarios).toEqual([
      "introduced-binding-renamed-against-call-site",
      "captured-binding-keeps-call-site-identity",
      "template-name-resolves-at-the-definition",
      "introduced-parameter-does-not-escape",
    ]);
  });
});
