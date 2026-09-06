import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { watchConfiguredProject } from "@sweetener/cli";
import ts from "typescript";

const directory = import.meta.dirname;
const consumerRoot = process.env["SWEETENER_CONSUMER_ROOT"]
  ? resolve(process.env["SWEETENER_CONSUMER_ROOT"])
  : directory;
const executable = resolve(
  consumerRoot,
  "node_modules/@sweetener/cli/dist/src/bin.js",
);
const started = performance.now();
const output = execFileSync(
  process.execPath,
  [executable, "build", "-p", resolve(directory, "tsconfig.json")],
  { cwd: directory, encoding: "utf8" },
);
const buildMs = performance.now() - started;
const expandedView = execFileSync(
  process.execPath,
  [executable, "expand", resolve(directory, "src/main.sts")],
  { cwd: directory, encoding: "utf8" },
);
const explanation = JSON.parse(
  execFileSync(
    process.execPath,
    [
      executable,
      "explain",
      "--json",
      `${resolve(directory, "src/main.sts")}:5:43`,
    ],
    { cwd: directory, encoding: "utf8" },
  ),
);
const generated = readFileSync(resolve(directory, "dist/main.js"), "utf8");
const declaration = readFileSync(resolve(directory, "dist/main.d.ts"), "utf8");
const workflowDeclaration = readFileSync(
  resolve(directory, "dist/workflow.d.ts"),
  "utf8",
);
const runtime = await import(
  `${pathToFileURL(resolve(directory, "dist/main.js")).href}?${String(Date.now())}`
);
const workflow = await import(
  `${pathToFileURL(resolve(directory, "dist/workflow.js")).href}?${String(Date.now())}`
);
const callbacks = new Map();
const results = [];
const mainSourcePath = resolve(directory, "src/main.sts");
const macroSourcePath = resolve(directory, "src/macros.sts");
const originalMain = readFileSync(mainSourcePath, "utf8");
const originalMacros = readFileSync(macroSourcePath, "utf8");
const watch = watchConfiguredProject({
  configPath: resolve(directory, "tsconfig.json"),
  writeThrough: false,
  onResult: (result) => results.push(result),
  system: {
    ...ts.sys,
    watchFile: (fileName, callback) => {
      callbacks.set(resolve(fileName), callback);
      return { close: () => callbacks.delete(resolve(fileName)) };
    },
  },
});
// A watch waits for a burst of writes to settle before it rebuilds, so an
// edit is answered on a later turn rather than inside the notification.
const rebuilt = async (text) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      results
        .at(-1)
        ?.virtualFiles.some(({ generated }) => generated.text.includes(text))
    )
      return true;
    await delay(10);
  }
  return false;
};
try {
  writeFileSync(mainSourcePath, originalMain.replace("twice(21)", "twice(22)"));
  callbacks.get(mainSourcePath)?.(
    mainSourcePath,
    ts.FileWatcherEventKind.Changed,
  );
  if (!(await rebuilt("[22,22]")))
    throw new Error("call-site watch edit was not rebuilt");
  writeFileSync(
    macroSourcePath,
    originalMacros.replace("[$value, $value]", "[$value, $value, $value]"),
  );
  callbacks.get(macroSourcePath)?.(
    macroSourcePath,
    ts.FileWatcherEventKind.Changed,
  );
  if (!(await rebuilt("[22,22,22]")))
    throw new Error("macro-definition watch edit was not rebuilt");
} finally {
  watch.close();
  writeFileSync(mainSourcePath, originalMain);
  writeFileSync(macroSourcePath, originalMacros);
}
if (!output.includes("build: success")) throw new Error("CLI build failed");
if (!expandedView.includes("[21,21]"))
  throw new Error("CLI expansion view failed");
if (explanation.invocations?.[0]?.attemptedRules?.[0]?.status !== "selected")
  throw new Error("CLI expansion explanation failed");
if (!generated.includes("[21, 21]") && !generated.includes("[21,21]"))
  throw new Error("expression macro was not emitted");
if (!generated.includes("return;"))
  throw new Error("statement macro was not emitted");
if (!/double\(\(?\s*21/u.test(generated))
  throw new Error("operator macro was not emitted");
if (!declaration.includes("number[] | undefined"))
  throw new Error("type macro was not emitted into declarations");
if (JSON.stringify(runtime.answer) !== "[21,21]")
  throw new Error("expanded runtime value is incorrect");
if (runtime.generated !== 7) throw new Error("item runtime value is incorrect");
if (runtime.piped !== 42)
  throw new Error("operator runtime value is incorrect");
if (!workflowDeclaration.includes("class OrderPlaced"))
  throw new Error("generated event declaration is missing");
if (
  JSON.stringify(workflow.audit) !== '["A-17",42.5]' ||
  workflow.transformed !== 4250 ||
  JSON.stringify(workflow.copies) !== '["A-17","A-17"]' ||
  workflow.readyToShip(workflow.order) !== "A-17:4250"
)
  throw new Error("composed workflow runtime behavior is incorrect");

process.stdout.write(
  `${JSON.stringify({ cli: "pass", expand: "pass", explain: "pass", watchCallSite: "pass", watchMacro: "pass", expression: "pass", statement: "pass", item: "pass", type: "pass", operator: "pass", declaration: "pass", runtime: "pass", composedWorkflow: "pass", buildMs })}\n`,
);
