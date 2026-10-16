import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);

test("Node imports and executes .sts through registration hooks", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-node-"));
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(root, "value.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const answer: number[] = twice(21);\n`,
  );
  writeFileSync(
    join(root, "main.mjs"),
    `import { answer } from "./value.sts";\nconsole.log(answer.join(","));\n`,
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["value.sts", "macros.sts"],
    }),
  );
  const result = await execute(
    process.execPath,
    [
      "--import",
      resolve("packages/node/dist/src/register.js"),
      join(root, "main.mjs"),
    ],
    { encoding: "utf8" },
  );
  expect(result.stdout.trim()).toBe("21,21");
  // Node 26 deprecates `module.register` and says so on every run through it;
  // registration picks whichever API the running Node does not warn about.
  expect(result.stderr).toBe("");
});

/**
 * A thrown error has to name the line the author wrote.
 *
 * Node is handed expanded, type-stripped JavaScript under the `.sts` file
 * name. Without a map every frame carries its position in the expansion —
 * shifted by whatever the compile-time import occupied — and the source frame
 * Node prints above the trace is read from the `.sts` at that wrong line.
 */
test("reports a stack frame at the line in the .sts source", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-node-trace-"));
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  // `boom` is on line 4 and its call on line 8. Both sit after the import the
  // expansion removes, so neither line survives into the generated text.
  writeFileSync(
    join(root, "value.sts"),
    `import { twice } from "./macros.sts" for syntax;\n` +
      `\n` +
      `export function boom(): never {\n` +
      `  throw new Error("kaboom");\n` +
      `}\n` +
      `\n` +
      `export const answer: number[] = twice(21);\n` +
      `boom();\n`,
  );
  writeFileSync(join(root, "main.mjs"), `await import("./value.sts");\n`);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["value.sts", "macros.sts"],
    }),
  );
  const failure = await execute(
    process.execPath,
    [
      "--import",
      resolve("packages/node/dist/src/register.js"),
      "--enable-source-maps",
      join(root, "main.mjs"),
    ],
    { encoding: "utf8" },
  ).then(
    () => undefined,
    (error: { stderr: string }) => error.stderr,
  );
  expect(failure, "the program was expected to throw").toBeDefined();
  expect(failure).toContain("value.sts:4:9");
  expect(failure).toContain("value.sts:8:1");
});

/**
 * What expansion holds about a name it left standing is said before the
 * module runs, so it is there beside the error the name then throws.
 *
 * Said through `process.emitWarning`, it was printed on a later tick -- and a
 * module that throws at its top level ends the process before that tick, so
 * the `ReferenceError` the sentence explains was printed alone.
 */
test("says what it holds about a name before the module throws over it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-node-held-"));
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax query:expr { rule { query($x:expr) } => { [$x] } }\n`,
  );
  writeFileSync(
    join(root, "main.sts"),
    `import { query } from "./macros.sts" for syntax;\nconsole.log(query);\n`,
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["main.sts", "macros.sts"],
    }),
  );
  const failure = await execute(
    process.execPath,
    [
      "--import",
      resolve("packages/node/dist/src/register.js"),
      join(root, "main.sts"),
    ],
    { encoding: "utf8" },
  ).then(
    () => undefined,
    (error: { readonly stderr: string }) => error,
  );
  expect(failure?.stderr).toContain("ReferenceError: query is not defined");
  expect(failure?.stderr).toContain("warning TS4024");
  expect(failure?.stderr.indexOf("warning TS4024")).toBeLessThan(
    failure?.stderr.indexOf("ReferenceError") ?? 0,
  );
});
