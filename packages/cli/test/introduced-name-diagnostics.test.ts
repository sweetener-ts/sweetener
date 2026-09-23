import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Names a macro introduces are reported on the invocation, and the rule that
 * wrote each one is named beside that report.
 *
 * `pair` expands to `[alpha, beta]`. Both names are missing, and both
 * diagnostics land on the `pair` token — the invocation is the only place an
 * introduced name belongs. They used to be indistinguishable there. The
 * related location is the identifier in the rule, so `alpha` and `beta` point
 * at different text. A name the call site wrote is not one of these: it is
 * reported where it was written.
 */

function check(macros: string, main: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-introduced-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), main);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  return { directory, macros, main, result };
}

describe("diagnostics for names a macro introduces", () => {
  test("points each introduced name back at the rule that wrote it", () => {
    const macros = `export syntax pair:expr { rule { pair } => { [alpha, beta] } }\n`;
    const main = `import { pair } from "./macros.sts" for syntax;\nexport const made = pair;\n`;
    const { result } = check(macros, main);
    const missing = result.diagnostics.filter(({ code }) => code === 2304);
    expect(
      missing.map(({ messageText }) => String(messageText)).sort(),
    ).toEqual(["Cannot find name 'alpha'.", "Cannot find name 'beta'."]);
    const invocation = main.indexOf("pair;");
    expect(invocation).toBeGreaterThan(0);
    for (const diagnostic of missing) {
      expect(diagnostic.file?.fileName).toMatch(/main\.sts$/u);
      expect(diagnostic.start).toBe(invocation);
      expect(
        main.slice(diagnostic.start, diagnostic.start! + diagnostic.length!),
      ).toBe("pair");
    }
    const introduced = missing.map((diagnostic) => {
      const related = diagnostic.relatedInformation?.find((entry) =>
        String(entry.messageText).includes("introduced by this macro rule"),
      );
      expect(related?.file?.fileName).toMatch(/macros\.sts$/u);
      return macros.slice(
        related?.start,
        (related?.start ?? 0) + (related?.length ?? 0),
      );
    });
    expect(introduced.sort()).toEqual(["alpha", "beta"]);
  });

  test("points a unicode introduced name back at the rule that wrote it", () => {
    const macros = "export syntax pair:expr { rule { pair } => { π } }\n";
    const main = `import { pair } from "./macros.sts" for syntax;\nexport const made = pair;\n`;
    const { result } = check(macros, main);
    const missing = result.diagnostics.filter(({ code }) => code === 2304);
    expect(missing.map(({ messageText }) => String(messageText))).toEqual([
      "Cannot find name 'π'.",
    ]);
    const invocation = main.indexOf("pair;");
    const diagnostic = missing[0];
    expect(diagnostic?.start).toBe(invocation);
    const related = diagnostic?.relatedInformation?.find((entry) =>
      String(entry.messageText).includes("introduced by this macro rule"),
    );
    expect(related?.file?.fileName).toMatch(/macros\.sts$/u);
    expect(
      macros.slice(
        related?.start,
        (related?.start ?? 0) + (related?.length ?? 0),
      ),
    ).toBe("π");
  });

  test("reports a name the call site wrote where it was written", () => {
    const macros = `export syntax bad:expr { rule { bad($name:ident) } => { $name } }\n`;
    const main = `import { bad } from "./macros.sts" for syntax;\nexport const made = bad(missing);\n`;
    const { result } = check(macros, main);
    const missing = result.diagnostics.filter(({ code }) => code === 2304);
    expect(missing).toHaveLength(1);
    const diagnostic = missing[0]!;
    expect(diagnostic.file?.fileName).toMatch(/main\.sts$/u);
    expect(
      main.slice(diagnostic.start, diagnostic.start! + diagnostic.length!),
    ).toBe("missing");
  });
});
