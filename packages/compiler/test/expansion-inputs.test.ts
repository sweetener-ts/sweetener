import * as ts from "typescript";
import { expect, test } from "vitest";
import {
  checkedInputs,
  createDefaultProjectExpansionProvider,
  inputsHold,
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
  const project: LoadedSweetProject = {
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
    typescript: {
      fileNames: [`${root}/macros.sts`, `${root}/main.sts`],
      options,
      errors: [],
    },
    problems: [],
  };
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
  expect(inputsHold(checked)).toBe(true);

  files.set(`${root}/shapes.ts`, "export const Shape = 2;\n");
  expect(inputsHold(checked)).toBe(false);
  expect(answerOf()).toContain('"other"');
});
