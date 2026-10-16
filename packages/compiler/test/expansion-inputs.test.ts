import * as ts from "typescript";
import { expect, test } from "vitest";
import {
  checkedInputs,
  createDefaultProjectExpansionProvider,
  InputCheckRound,
  nowNanoseconds,
  type LoadedSweetProject,
} from "../src/index.js";

const root = "/memory";

/**
 * A file system held in memory, the way the playground hands one to
 * expansion: files only, no stats, no links, and no disk behind it.
 */
function memorySystem(files: Map<string, string>): ts.System {
  const inside = (directory: string) =>
    [...files.keys()].filter((fileName) =>
      fileName.startsWith(`${directory.replace(/\/$/u, "")}/`),
    );
  return {
    args: [],
    newLine: "\n",
    useCaseSensitiveFileNames: true,
    write: () => {},
    readFile: (fileName) => files.get(fileName),
    writeFile: (fileName) => {
      throw new Error(`Expansion wrote ${fileName}`);
    },
    resolvePath: (fileName) => fileName,
    fileExists: (fileName) => files.has(fileName),
    directoryExists: (directory) => inside(directory).length > 0,
    createDirectory: (directory) => {
      throw new Error(`Expansion created ${directory}`);
    },
    getExecutingFilePath: () => `${root}/typescript.js`,
    getCurrentDirectory: () => root,
    getDirectories: (directory) => [
      ...new Set(
        inside(directory)
          .map((fileName) => fileName.slice(directory.length + 1).split("/"))
          .filter((parts) => parts.length > 1)
          .map(([name]) => name!),
      ),
    ],
    readDirectory: () => [...files.keys()],
    exit: () => {},
  };
}

/** A project of these files, held in memory and listed by no config. */
function memoryProject(
  fileNames: readonly string[],
  options: ts.CompilerOptions,
): LoadedSweetProject {
  return {
    configPath: `${root}/tsconfig.json`,
    configurationInputs: [],
    sweet: {
      languageVersion: "1",
      typescriptVersionPolicy: "exact",
      macroExtensions: [".sts", ".stsx"],
      allowCoreShadowing: true,
      sourceDeclarations: false,
      trace: "off",
      limits: {},
    },
    typescript: { fileNames: [...fileNames], options, errors: [] },
    problems: [],
  };
}

/**
 * Whether a `.ts` file opted in with `"use sweetener"` is read like every
 * other source: from the file system expansion was given, as an input.
 */
test("reads a directive from the file system expansion reads", () => {
  const source = `${root}/a.ts`;
  const files = new Map([[source, '"use sweetener";\nexport const x = 1;\n']]);
  const provider = createDefaultProjectExpansionProvider({
    system: memorySystem(files),
  });
  const project = memoryProject([source], {
    allowNonTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  });
  const expanded = provider.expandProject(project);
  expect(expanded.files.map(({ fileName }) => fileName)).toEqual([source]);
  expect(expanded.inputs).toContainEqual({
    kind: "file",
    path: source,
    text: files.get(source),
  });

  files.set(source, "export const x = 1;\n");
  expect(provider.expandProject(project).files).toEqual([]);
});

/**
 * What expansion read resolving a binding literal is checked against the file
 * system it read from. Held in memory, that is the only place the files are:
 * checking against the disk would find none of them.
 */
test("checks a binding literal's inputs against the file system expansion read", () => {
  const options: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  };
  const library = `${root}/${ts.getDefaultLibFileName(options)}`;
  const files = new Map([
    [
      library,
      "interface Object {} interface Function {} interface CallableFunction extends Function {} interface NewableFunction extends Function {} interface IArguments {} interface String {} interface Number {} interface Boolean {} interface RegExp {} interface Array<T> { length: number; [index: number]: T; }",
    ],
    [`${root}/local.ts`, "export const Circle = 1;\n"],
    [`${root}/shapes.ts`, 'export { Circle as Shape } from "./local";\n'],
    [
      `${root}/macros.sts`,
      [
        'import { Circle } from "./local";',
        "export syntax kind:expr {",
        "  literal Circle as Circle;",
        '  rule { kind(Circle) } => { "circle" }',
        '  fallback rule { kind($value:expr) } => { "other" }',
        "}",
        "",
      ].join("\n"),
    ],
    [
      `${root}/main.sts`,
      'import { kind } from "./macros.sts" for syntax;\nimport { Shape } from "./shapes";\nexport const answer = kind(Shape);\n',
    ],
  ]);
  const project = memoryProject(
    [`${root}/macros.sts`, `${root}/main.sts`],
    options,
  );
  const provider = createDefaultProjectExpansionProvider({
    system: memorySystem(files),
  });
  const answerOf = () =>
    provider
      .expandProject(project)
      .files.find(({ fileName }) => fileName.includes("main"))?.generated.text;

  expect(answerOf()).toContain('"circle"');
  const expanded = provider.expandProject(project);
  const read = expanded.inputs.flatMap((input) =>
    input.kind === "file" && input.text !== undefined ? [input.path] : [],
  );
  expect(read).toEqual(
    expect.arrayContaining([library, `${root}/local.ts`, `${root}/shapes.ts`]),
  );
  const checked = checkedInputs(
    provider.fileSystem,
    nowNanoseconds(),
  )(expanded.inputs);
  expect(new InputCheckRound().hold(checked)).toBe(true);

  files.set(`${root}/shapes.ts`, "export const Shape = 2;\n");
  expect(new InputCheckRound().hold(checked)).toBe(false);
  expect(answerOf()).toContain('"other"');
});

/**
 * A macro module whose own slash regroups its tokens is read again with the
 * whole project. Every read takes the text the first one recorded, so a file
 * written while the project is read again cannot give one expansion two
 * texts -- nor slash readings made for a text it no longer holds.
 */
test("reads a project read again for a slash from what its first read recorded", () => {
  const macros = `${root}/macros.sts`;
  const main = `${root}/main.sts`;
  const macroText = (factor: number) =>
    `export syntax twice:expr { rule { twice($v:expr) } => { $v * ${String(factor)} } }\n` +
    "export function test(s: string) {\n" +
    "  let x: string\n" +
    "  /[(]/.test(s);\n" +
    "}\n";
  const files = new Map([
    [macros, macroText(2)],
    [
      main,
      'import { twice } from "./macros.sts" for syntax;\nexport const t = twice(3);\n',
    ],
  ]);
  const system = memorySystem(files);
  let macroReads = 0;
  const provider = createDefaultProjectExpansionProvider({
    system: {
      ...system,
      readFile: (fileName) => {
        const text = system.readFile(fileName);
        if (fileName === macros) {
          macroReads += 1;
          // Written as soon as it has been read.
          files.set(macros, `\n${macroText(3)}`);
        }
        return text;
      },
    },
  });
  const project = memoryProject([macros, main], {
    allowNonTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  });

  const expanded = provider.expandProject(project);
  expect(expanded.diagnostics).toEqual([]);
  expect(macroReads).toBe(1);
  expect(
    expanded.files.find(({ fileName }) => fileName.includes("main"))?.generated
      .text,
  ).toContain("export const t = 3 * 2;");
  expect(
    expanded.files.find(({ fileName }) => fileName.includes("macros"))
      ?.generated.text,
  ).toContain("/[(]/.test(s);");
  expect(expanded.inputs).toContainEqual({
    kind: "file",
    path: macros,
    text: macroText(2),
  });
});
