import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
  runCli,
  runConfiguredProjectCommand,
} from "../src/index.js";

/**
 * A file whose macros did not compile expands into itself.
 *
 * An inspection carried only the diagnostics raised against the file it
 * described, so a fault in the macro module it imports was invisible to it:
 * `expand` printed the unexpanded source and reported success, and `explain`
 * reported the origins of an expansion that never happened -- which reads as an
 * expansion in which every token came from the source, exactly what an
 * unexpanded file looks like.
 */

function project(macros: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-inspection-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    'import { twice } from "./macros.sts" for syntax;\nexport const a = twice(1);\n',
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  return directory;
}

const broken =
  "export syntax twice:expr { rule { twice($x:tt) } => { #bogus($x) } }";
const working =
  "export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }";

function inspect(macros: string) {
  const directory = project(macros);
  const provider = createDefaultProjectExpansionProvider();
  provider.expandProject(loadSweetProject(join(directory, "tsconfig.json")));
  return {
    directory,
    inspection: provider.inspectSource(join(directory, "main.sts")),
    provider,
  };
}

describe("what an inspection reports", () => {
  test("carries the errors of the macro module it imports", () => {
    const { inspection } = inspect(broken);
    expect(
      inspection?.diagnostics.map(({ messageText }) => String(messageText)),
    ).toEqual(["Template has no operation #bogus."]);
  });

  test("carries nothing when the macros compiled", () => {
    const { inspection } = inspect(working);
    expect(inspection?.diagnostics).toEqual([]);
    expect(inspection?.generated.text).toContain("[1, 1]");
  });

  test("expand and explain both refuse a file whose macros failed", () => {
    const { directory, provider } = inspect(broken);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    };
    const main = join(directory, "main.sts");
    expect(
      runCli({
        argv: ["expand", main],
        expansionProvider: provider,
        inspectionProvider: provider,
        io,
      }).exitCode,
    ).toBe(1);
    expect(
      runCli({
        argv: ["explain", `${main}:2:18`],
        expansionProvider: provider,
        inspectionProvider: provider,
        io,
      }).exitCode,
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("#bogus");
  });

  test("expand prints the expansion when the macros compiled", () => {
    const { directory, provider } = inspect(working);
    const stdout: string[] = [];
    expect(
      runCli({
        argv: ["expand", join(directory, "main.sts")],
        expansionProvider: provider,
        inspectionProvider: provider,
        io: { stdout: (text: string) => stdout.push(text), stderr: () => {} },
      }).exitCode,
    ).toBe(0);
    expect(stdout.join("")).toContain("[1, 1]");
  });
});

describe("where a diagnostic's related locations point", () => {
  test("related information is mapped back to the source", () => {
    // A diagnostic's related locations are positions in the same generated
    // file, and were carried through untouched: they named the virtual `.ts`,
    // which no `check` ever writes, at offsets into text nobody had.
    const directory = mkdtempSync(join(tmpdir(), "sweet-related-"));
    writeFileSync(
      join(directory, "macros.sts"),
      "export syntax nop:expr { rule { nop($x:tt) } => { $x } }",
    );
    const source = `import { nop } from "./macros.sts" for syntax;
interface Shape { size: number; }
interface Shape { size: string; }
export const a = nop(1);
`;
    writeFileSync(join(directory, "main.sts"), source);
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
    const diagnostic = result.diagnostics.find(({ code }) => code === 2717);
    expect(diagnostic).toBeDefined();
    const related = diagnostic?.relatedInformation?.[0];
    expect(related?.file?.fileName).toMatch(/main\.sts$/u);
    // Both positions name the `size` each declaration writes.
    expect(source.slice(related?.start, (related?.start ?? 0) + 4)).toBe(
      "size",
    );
    expect(source.slice(diagnostic?.start, (diagnostic?.start ?? 0) + 4)).toBe(
      "size",
    );
  });
});
