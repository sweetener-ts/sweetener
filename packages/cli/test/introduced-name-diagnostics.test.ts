import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import {
  MappedLanguageService,
  VirtualLanguageServiceProject,
} from "@sweetener/typescript-host";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
  runConfiguredProjectCommand,
} from "../src/index.js";

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
 *
 * `check` and an editor's language service read the same expansion, and they
 * say the same thing about it.
 */

const definition = "Macro template definition";

function project(macros: string, main: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-introduced-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), main);
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  return { directory, configPath };
}

/** What is said about each missing name, as `check` reports it. */
function checkedNames(macros: string, main: string, code = 2304) {
  const { configPath } = project(macros, main);
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath,
    writeThrough: false,
  });
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map((diagnostic) => ({
      message: String(diagnostic.messageText),
      reported: main.slice(
        diagnostic.start,
        diagnostic.start! + diagnostic.length!,
      ),
      related: (diagnostic.relatedInformation ?? []).map((entry) => {
        const inMacros = entry.file?.fileName.endsWith("macros.sts") === true;
        return {
          message: String(entry.messageText),
          file: inMacros ? "macros" : "main",
          text: (inMacros ? macros : main).slice(
            entry.start,
            entry.start! + entry.length!,
          ),
        };
      }),
    }))
    .sort((left, right) => left.message.localeCompare(right.message));
}

/** What is said about each missing name, as an editor is told it. */
function editorNames(macros: string, main: string, code = 2304) {
  const { directory, configPath } = project(macros, main);
  const provider = createDefaultProjectExpansionProvider();
  const expansion = provider.expandProject(loadSweetProject(configPath));
  const inspectedMain = provider.inspectSource(join(directory, "main.sts"));
  const inspectedMacros = provider.inspectSource(join(directory, "macros.sts"));
  if (inspectedMain === undefined || inspectedMacros === undefined)
    throw new Error("the project's sources were not inspected");
  const virtualFileName = expansion.files.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.fileName;
  if (virtualFileName === undefined) throw new Error("no virtual main.ts");
  const service = new MappedLanguageService(
    new VirtualLanguageServiceProject({
      compilerOptions: {
        noEmit: true,
        strict: false,
        target: ts.ScriptTarget.ES2022,
      },
      currentDirectory: directory,
      files: expansion.files.map(({ fileName, generated }) => ({
        fileName,
        generated,
      })),
    }),
    [
      {
        sourceFileName: join(directory, "main.sts"),
        sourceId: inspectedMain.sourceId,
        virtualFileName,
        printed: inspectedMain.generated,
        index: inspectedMain.index,
        origins: inspectedMain.origins,
      },
    ],
  );
  return service
    .diagnostics(join(directory, "main.sts"))
    .filter(({ typescriptCode }) => typescriptCode === code)
    .map((diagnostic) => ({
      message: diagnostic.messageText,
      reported: main.slice(
        diagnostic.primaryOrigin?.start,
        diagnostic.primaryOrigin?.end,
      ),
      related: diagnostic.relatedOrigins.map(({ message, origin }) => {
        const inMacros = origin.sourceId === inspectedMacros.sourceId;
        return {
          message,
          file: inMacros ? "macros" : "main",
          text: (inMacros ? macros : main).slice(origin.start, origin.end),
        };
      }),
    }))
    .sort((left, right) => left.message.localeCompare(right.message));
}

const imports = (name: string) =>
  `import { ${name} } from "./macros.sts" for syntax;\nexport const made = ${name};\n`;

describe("diagnostics for names a macro introduces", () => {
  test("points each introduced name back at the rule that wrote it", () => {
    const macros = `export syntax pair:expr { rule { pair } => { [alpha, beta] } }\n`;
    expect(checkedNames(macros, imports("pair"))).toEqual([
      {
        message: "Cannot find name 'alpha'.",
        reported: "pair",
        related: [{ message: definition, file: "macros", text: "alpha" }],
      },
      {
        message: "Cannot find name 'beta'.",
        reported: "pair",
        related: [{ message: definition, file: "macros", text: "beta" }],
      },
    ]);
  });

  test("points a unicode introduced name back at the rule that wrote it", () => {
    const macros = "export syntax pair:expr { rule { pair } => { π } }\n";
    expect(checkedNames(macros, imports("pair"))).toEqual([
      {
        message: "Cannot find name 'π'.",
        reported: "pair",
        related: [{ message: definition, file: "macros", text: "π" }],
      },
    ]);
  });

  test("points a name spelled like a contextual keyword back at the rule", () => {
    const macros = `export syntax names:expr { rule { names } => { [type, of, async] } }\n`;
    expect(
      checkedNames(macros, imports("names")).map(({ related }) => related),
    ).toEqual([
      [{ message: definition, file: "macros", text: "async" }],
      [{ message: definition, file: "macros", text: "of" }],
      [{ message: definition, file: "macros", text: "type" }],
    ]);
  });

  test("reports a name the call site wrote where it was written", () => {
    const macros = `export syntax bad:expr { rule { bad($name:ident) } => { $name } }\n`;
    const main = `import { bad } from "./macros.sts" for syntax;\nexport const made = bad(missing);\n`;
    expect(checkedNames(macros, main)).toEqual([
      {
        message: "Cannot find name 'missing'.",
        reported: "missing",
        related: [],
      },
    ]);
  });

  // An error about what the author wrote is about that text and nothing
  // else: it is reported over all of it, and related to nothing.
  test.each([
    ["written in the file", "g(1, 2, 3);"],
    ["copied by a macro", "export const copied = twice(g(1, 2, 3));"],
  ])("reports an error about text %s over all of it", (_label, line) => {
    const macros =
      "export syntax twice:expr { rule { twice($v:expr) } => { [$v, $v] } }\n";
    const main =
      `import { twice } from "./macros.sts" for syntax;\n` +
      `declare function g(): void;\n${line}\n`;
    const expected = [
      {
        message: "Expected 0 arguments, but got 3.",
        reported: "1, 2, 3",
        related: [],
      },
    ];
    expect(checkedNames(macros, main, 2554).slice(0, 1)).toEqual(expected);
    expect(editorNames(macros, main, 2554).slice(0, 1)).toEqual(expected);
  });

  test.each([
    ["two names", "pair", "[alpha, beta]"],
    ["a unicode name", "pair", "π"],
    ["names spelled like contextual keywords", "names", "[type, of, async]"],
  ])(
    "tells an editor what check reports about %s",
    (_label, name, template) => {
      const macros = `export syntax ${name}:expr { rule { ${name} } => { ${template} } }\n`;
      const main = imports(name);
      const checked = checkedNames(macros, main);
      expect(checked.length).toBeGreaterThan(0);
      expect(editorNames(macros, main)).toEqual(checked);
    },
  );
});
