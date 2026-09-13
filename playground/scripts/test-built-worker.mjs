import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

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
}

nodeProcess.stdout.write(
  `Built browser worker expanded all ${directories.length} playground examples.\n`,
);
