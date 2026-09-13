import pipelineMacros from "../examples/pipeline/macros.sts?raw";
import pipelineMain from "../examples/pipeline/main.sts?raw";
import unlessMacros from "../examples/unless/macros.sts?raw";
import unlessMain from "../examples/unless/main.sts?raw";
import matchingMacros from "../examples/matching/macros.sts?raw";
import matchingMain from "../examples/matching/main.sts?raw";
import debugMacros from "../examples/debug/macros.sts?raw";
import debugMain from "../examples/debug/main.sts?raw";
import recordsMacros from "../examples/records/macros.sts?raw";
import recordsMain from "../examples/records/main.sts?raw";
import adtMacros from "../examples/adt/macros.sts?raw";
import adtMain from "../examples/adt/main.sts?raw";
import jsxRuntime from "../examples/jsx/runtime.ts?raw";
import jsxMacros from "../examples/jsx/macros.sts?raw";
import jsxMain from "../examples/jsx/main.stsx?raw";
import signalsRuntime from "../examples/signals/runtime.ts?raw";
import signalsMacros from "../examples/signals/macros.sts?raw";
import signalsMain from "../examples/signals/main.sts?raw";
// These are written against `effect`, `zod` and `drizzle-orm`, so they live in their
// own package where CI type-checks them against the real libraries; the
// playground reads them from there rather than keeping a copy that could
// drift. The browser only expands them, so the libraries are not needed here.
import zodMacros from "../../examples/library-macros/zod-schema/macros.sts?raw";
import zodMain from "../../examples/library-macros/zod-schema/main.sts?raw";
import effectServiceMacros from "../../examples/library-macros/effect-service/macros.sts?raw";
import effectServiceMain from "../../examples/library-macros/effect-service/main.sts?raw";
import effectDoService from "../../examples/library-macros/effect-do/service.sts?raw";
import effectDoMacros from "../../examples/library-macros/effect-do/macros.sts?raw";
import effectDoMain from "../../examples/library-macros/effect-do/main.sts?raw";
import drizzleSchemaMacros from "../../examples/library-macros/drizzle-schema/macros.sts?raw";
import drizzleSchemaMain from "../../examples/library-macros/drizzle-schema/main.sts?raw";
import drizzleQueryMacros from "../../examples/library-macros/drizzle-query/macros.sts?raw";
import drizzleQueryMain from "../../examples/library-macros/drizzle-query/main.sts?raw";

export type PlaygroundFile = { fileName: string; source: string };
export type PlaygroundExample = {
  id: string;
  name: string;
  summary: string;
  entryFileName: string;
  files: PlaygroundFile[];
};

const example = (
  id: string,
  name: string,
  summary: string,
  macros: string,
  main: string,
  extra: PlaygroundFile[] = [],
  entryFileName = "main.sts",
): PlaygroundExample => ({
  id,
  name,
  summary,
  entryFileName,
  files: [
    ...extra,
    { fileName: "macros.sts", source: macros },
    { fileName: entryFileName, source: main },
  ],
});

/**
 * The first three are the ones worth meeting first: a sum type with a match
 * that knows its constructors, control flow inside JSX, and an operator with
 * its own precedence. The rest follow.
 *
 * Each is a whole working program rather than a fragment, and the build
 * expands every one of them, so an example that stopped compiling would fail
 * the build rather than greet the next person who opened it.
 */
export const examples: PlaygroundExample[] = [
  example(
    "adt",
    "Algebraic data types",
    "`data` generates a union and its constructors; `match` knows them.",
    adtMacros,
    adtMain,
  ),
  example(
    "jsx",
    "Control flow in JSX",
    "`when` and `each` as real syntax, instead of ternaries and .map().",
    jsxMacros,
    jsxMain,
    [{ fileName: "runtime.ts", source: jsxRuntime }],
    "main.stsx",
  ),
  example(
    "pipeline",
    "Pipeline operator",
    "An infix operator with its own precedence.",
    pipelineMacros,
    pipelineMain,
  ),
  example(
    "unless",
    "Custom control flow",
    "A statement macro that takes a block.",
    unlessMacros,
    unlessMain,
  ),
  example(
    "debug",
    "Debug and assert",
    "Macros that can read the source text you wrote.",
    debugMacros,
    debugMain,
  ),
  example(
    "records",
    "Generated classes",
    "One declaration expands into a class, a constructor, and a printer.",
    recordsMacros,
    recordsMain,
  ),
  example(
    "matching",
    "Pattern matching",
    "Structural patterns with bindings and guards, and no runtime at all.",
    matchingMacros,
    matchingMain,
  ),
  example(
    "signals",
    "Reactive state",
    "A macro that writes a macro, so state reads and writes like a variable.",
    signalsMacros,
    signalsMain,
    [{ fileName: "runtime.ts", source: signalsRuntime }],
  ),
  example(
    "zod-schema",
    "Zod schemas from types",
    "One declaration emits the interface and the zod schema that validates it.",
    zodMacros,
    zodMain,
  ),
  example(
    "effect-service",
    "Effect services",
    "`service` and `error` write the Context.Tag, accessors, and layer for you.",
    effectServiceMacros,
    effectServiceMain,
  ),
  example(
    "effect-do",
    "Effect do-notation",
    "`gen` blocks with `name <- effect` binds, and `handle` for typed errors.",
    effectDoMacros,
    effectDoMain,
    [{ fileName: "service.sts", source: effectDoService }],
  ),
  example(
    "drizzle-schema",
    "Drizzle tables",
    "One `table` declaration is the Drizzle table, its row type, and its insert type.",
    drizzleSchemaMacros,
    drizzleSchemaMain,
  ),
  example(
    "drizzle-query",
    "Drizzle queries",
    "Queries written in the order SQL reads, as the Drizzle builder chain.",
    drizzleQueryMacros,
    drizzleQueryMain,
  ),
];
