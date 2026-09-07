/// <reference lib="webworker" />

import { DefaultProjectExpansionProvider } from "../../packages/cli/src/default-expansion-provider.ts";
import type { LoadedSweetProject } from "../../packages/cli/src/configuration.ts";
import { existsSync, readFileSync, setVirtualFiles } from "./worker/virtual-fs";
import * as ts from "typescript";

export type PlaygroundFile = { fileName: string; source: string };
export type CompileRequest = {
  id: number;
  files: PlaygroundFile[];
  entryFileName: string;
};
export type CompileResponse = {
  id: number;
  result?: { outputs: PlaygroundFile[]; diagnostics: string[] };
  error?: string;
};

const root = "/playground";
const system: ts.System = {
  args: [],
  newLine: "\n",
  useCaseSensitiveFileNames: true,
  write: () => {},
  writeOutputIsTTY: () => false,
  getWidthOfTerminal: () => 80,
  readFile: (fileName) =>
    existsSync(fileName) ? readFileSync(fileName, "utf8") : undefined,
  writeFile: () => {},
  resolvePath: (fileName) => fileName,
  fileExists: existsSync,
  directoryExists: (directory) =>
    [...virtualFileNames].some((fileName) =>
      fileName.startsWith(`${directory.replace(/\/$/u, "")}/`),
    ),
  createDirectory: () => {},
  getExecutingFilePath: () => `${root}/typescript.js`,
  getCurrentDirectory: () => root,
  getDirectories: () => [],
  readDirectory: () => [...virtualFileNames],
  exit: () => {},
};
let virtualFileNames = new Set<string>();

function diagnosticText(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined)
    return `SWR${diagnostic.code}: ${message}`;
  const location = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return `${diagnostic.file.fileName.replace(`${root}/`, "")}:${location.line + 1}:${location.character + 1} SWR${diagnostic.code}: ${message}`;
}

function compile(request: CompileRequest) {
  const fileMap = new Map<string, string>();
  for (const file of request.files)
    fileMap.set(`${root}/${file.fileName}`, file.source);
  fileMap.set(`${root}/tsconfig.json`, "{}");
  fileMap.set(
    `${root}/lib.d.ts`,
    "declare var NaN: number; declare var Infinity: number; interface Object {} interface Function {} interface CallableFunction extends Function {} interface NewableFunction extends Function {} interface IArguments {} interface String {} interface Number {} interface Boolean {} interface RegExp {} interface Array<T> { readonly length: number; [index: number]: T; } interface ReadonlyArray<T> { readonly length: number; [index: number]: T; }",
  );
  virtualFileNames = new Set(fileMap.keys());
  setVirtualFiles(fileMap);

  const project: LoadedSweetProject = {
    configPath: `${root}/tsconfig.json`,
    sweet: {
      languageVersion: "1",
      typescriptVersionPolicy: "exact",
      macroExtensions: [".sts", ".stsx"],
      allowCoreShadowing: true,
      // The playground expands in the browser and imports nothing from a
      // .sts, so there is no ordinary TypeScript here to hand a declaration to.
      sourceDeclarations: false,
      trace: "full",
      limits: {},
    },
    typescript: {
      fileNames: request.files.map((file) => `${root}/${file.fileName}`),
      options: {
        allowNonTsExtensions: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        // So a .stsx example can be about JSX rather than about configuring it.
        jsx: ts.JsxEmit.React,
        jsxFactory: "h",
        jsxFragmentFactory: "Fragment",
      },
      errors: [],
    },
    problems: [],
  };

  const expanded = new DefaultProjectExpansionProvider({
    system,
  }).expandProject(project);
  return {
    outputs: expanded.files.map((file) => ({
      fileName: file.fileName.replace(`${root}/`, ""),
      source: file.generated.text,
    })),
    diagnostics: expanded.diagnostics.map(diagnosticText),
  };
}

self.addEventListener("message", (event: MessageEvent<CompileRequest>) => {
  try {
    self.postMessage({
      id: event.data.id,
      result: compile(event.data),
    } satisfies CompileResponse);
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    } satisfies CompileResponse);
  }
});
