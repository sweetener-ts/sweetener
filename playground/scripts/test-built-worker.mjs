import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
// Loaded before `process` is taken away below: TypeScript reads it on import.
import ts from "typescript";

const nodeProcess = globalThis.process;
const assets = path.join(import.meta.dirname, "../dist/assets");
const workerFile = (await readdir(assets)).find(
  (name) => name.startsWith("compiler-worker-") && name.endsWith(".js"),
);
if (!workerFile) throw new Error("Built compiler worker was not found");

let messageHandler;
let result;
globalThis.self = globalThis;
globalThis.process = undefined;
globalThis.addEventListener = (name, handler) => {
  if (name === "message") messageHandler = handler;
};
globalThis.postMessage = (message) => {
  result = message;
};

await import(pathToFileURL(path.join(assets, workerFile)).href);
if (!messageHandler) throw new Error("Compiler worker did not register");

// Every example the site ships, expanded by the worker the site ships. An
// example that stopped compiling would otherwise greet whoever opened it.
// The library examples are read from their own package, as src/examples.ts
// reads them, so the copy tested here is the copy CI type-checks.
const exampleRoots = [
  path.join(import.meta.dirname, "../examples"),
  path.join(import.meta.dirname, "../../examples/library-macros"),
];
const directories = [];
for (const examplesRoot of exampleRoots)
  for (const entry of await readdir(examplesRoot, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name !== "node_modules")
      directories.push({
        name: entry.name,
        directory: path.join(examplesRoot, entry.name),
      });
directories.sort((left, right) => left.name.localeCompare(right.name));
if (directories.length === 0)
  throw new Error("No playground examples were found");

const expanded = [];
for (const [index, { name, directory }] of directories.entries()) {
  // Whatever the example is made of: some carry a runtime module beside the
  // macros, and main.sts goes last so it can import the rest.
  const all = await readdir(directory);
  const entry = all.find((file) => file.startsWith("main."));
  if (entry === undefined) throw new Error(`${name}: no entry file`);
  const fileNames = all
    .filter((file) => file !== entry)
    .sort()
    .concat(entry);
  const files = await Promise.all(
    fileNames.map(async (fileName) => ({
      fileName,
      source: await readFile(path.join(directory, fileName), "utf8"),
    })),
  );
  result = undefined;
  await messageHandler({
    data: { id: index + 1, entryFileName: entry, files },
  });
  if (result?.error) throw new Error(`${name}: ${result.error}`);
  if (result?.result?.diagnostics?.length)
    throw new Error(`${name}: ${result.result.diagnostics.join("\n")}`);
  const output = result?.result?.outputs?.find(({ fileName }) =>
    fileName.startsWith("main."),
  )?.source;
  if (!output) throw new Error(`${name}: generated TypeScript was empty`);
  expanded.push({ name, directory, files, outputs: result.result.outputs });
}

// Expanding without a Sweetener diagnostic says nothing about whether what
// came out is TypeScript. So the real compiler reads every generated project,
// with the real libraries, laid over the example's own directory so that
// `effect` and `drizzle-orm` resolve exactly as they do for CI.
globalThis.process = nodeProcess;
const options = {
  allowImportingTsExtensions: true,
  // Whether generated JSX is well typed is a question about its elements and
  // attributes. Which function it is lowered to is the reader's choice of
  // runtime, so none is demanded here: an example written for React's
  // automatic runtime has no `h` in scope and is no worse for it.
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  types: [],
};
const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => path.join(import.meta.dirname, "../.."),
  getNewLine: () => "\n",
};
const failures = [];
for (const { name, directory, files, outputs } of expanded) {
  // The project as the playground holds it: what expansion generated, beside
  // the sources it left alone -- a runtime module, or the declarations an
  // example brings for a library the browser does not have.
  const generated = new Map(
    [
      ...files.filter(({ fileName }) => !/\.stsx?$/u.test(fileName)),
      ...outputs,
    ].map(({ fileName, source }) => [path.join(directory, fileName), source]),
  );
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (fileName) =>
    generated.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => generated.get(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    generated.has(fileName)
      ? ts.createSourceFile(fileName, generated.get(fileName), languageVersion)
      : getSourceFile(fileName, languageVersion, ...rest);
  const program = ts.createProgram([...generated.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0)
    failures.push(
      `${name}: the generated TypeScript does not type-check\n${ts.formatDiagnostics(diagnostics, formatHost)}`,
    );

  // A .ts file is not always a .tsx file: `<T>(value: T) => value` is a
  // generic arrow in one and an unclosed JSX tag in the other. The TypeScript
  // playground reads what is pasted into it as .tsx, and so does any .tsx
  // project the output is copied into, so generated .ts has to be both.
  for (const { fileName, source } of outputs) {
    if (!fileName.endsWith(".ts") || fileName.endsWith(".d.ts")) continue;
    const asTsx = ts.transpileModule(source, {
      fileName: `${path.join(directory, fileName)}x`,
      reportDiagnostics: true,
      compilerOptions: options,
    }).diagnostics;
    if (asTsx.length > 0)
      failures.push(
        `${name}: generated ${fileName} is TypeScript but not TSX, so the TypeScript playground rejects it\n${ts.formatDiagnostics(asTsx, formatHost)}`,
      );
  }
}
if (failures.length > 0) throw new Error(failures.join("\n"));

nodeProcess.stdout.write(
  `Built browser worker expanded all ${directories.length} playground examples, and TypeScript accepted what each one generated.\n`,
);
