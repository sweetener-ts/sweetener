import {
  createPhase,
  EnvironmentStore,
  ScopeStore,
} from "../packages/hygiene/dist/src/index.js";
import { parseMacroDefinitions } from "../packages/macro-language/dist/src/index.js";
import { readSyntax } from "../packages/reader/dist/src/index.js";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
} from "../packages/shared/dist/src/index.js";
import { OriginStore } from "../packages/syntax/dist/src/index.js";
import {
  compileParsedMacros,
  createExpansionFrontendSession,
  ExpansionGuard,
} from "../packages/expansion/dist/src/index.js";

/** How many declarations the repetition captures, at six tokens each. */
const DECLARATIONS = 2_000;

/**
 * One macro whose rules each capture its whole body in a single `$(…)*`.
 *
 * Every other scenario's repetitions run a handful of iterations. One that
 * copied what the earlier iterations captured, or built the capture sequence
 * again for every way out of the loop it offered, would cost the square of the
 * iterations and be invisible at a handful: 5,000 declarations took 33 s that
 * way, and 10,000 ran out of memory.
 *
 * The first rule never matches: after its repetition takes every token, it
 * tries each way out, from the last, against a word the body does not hold.
 * Building an exit's sequences when it was tried, before the word failed it,
 * cost the square of the iterations too: 4,000 declarations took 36 s.
 */
export function defineLongRepetitionBenchmark() {
  const definitionText = `export syntax emit:item {
  rule { emit { $($items:tt)* NEVER } } => {}
  rule { emit { $($items:tt)* } } => { $($items)* }
}
`;
  const declarations = Array.from(
    { length: DECLARATIONS },
    (_, index) => `export const value${String(index)} = ${String(index)};`,
  );
  const sourceText = `emit {\n${declarations.join("\n")}\n}`;
  return {
    id: "expansion/long-repetition",
    description: `Capture ${String(DECLARATIONS)} declarations in one repetition, failing every exit of another first, and replay them`,
    run() {
      const origins = new OriginStore();
      const scopes = new ScopeStore();
      const phase = createPhase(1);
      const definitionScopes = scopes.singleton(
        scopes.freshScope("module", "repetition-definition"),
      );
      const definitionRead = readSyntax(definitionText, {
        sourceId: 60,
        scopes: definitionScopes,
        originStore: origins,
      });
      const parsed = parseMacroDefinitions(definitionRead.root, {
        sourceId: 60,
      });
      const bindingIds = createIdAllocator(1_000);
      const syntaxIds = createIdAllocator(100_000);
      const invocationIds = createIdAllocator(1);
      const module = compileParsedMacros(parsed, {
        sourceId: 60,
        phase,
        definitionScopes,
        allocateBindingId: bindingIds.allocate,
        spanForOrigin: (origin) =>
          origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
      });
      if (definitionRead.diagnostics.length || module.diagnostics.length)
        throw new Error("Long-repetition benchmark macro did not compile");
      const tracker = new ResourceTracker(createResourceBudget());
      const session = createExpansionFrontendSession({
        module,
        sourceId: 61,
        phase,
        scopeStore: scopes,
        origins,
        environments: new EnvironmentStore(),
        tracker,
        guard: new ExpansionGuard({ tracker }),
        allocateSyntaxId: syntaxIds.allocate,
        allocateBindingId: bindingIds.allocate,
        allocateInvocationId: invocationIds.allocate,
      });
      const read = readSyntax(sourceText, {
        sourceId: 61,
        scopes: scopes.singleton(scopes.freshScope("module", "repetition-use")),
        originStore: origins,
      });
      const items = read.root.children.filter(
        (node) => node.tag !== "token" || node.kind !== "end-of-file",
      );
      const result = session.expand(items, "item");
      if (result.diagnostics.length > 0)
        throw new Error("Long-repetition benchmark produced diagnostics");
      let tokens = 0;
      const count = (node) => {
        if (node.tag === "token") tokens += 1;
        else for (const child of node.children) count(child);
      };
      for (const node of result.syntax) count(node);
      if (tokens < DECLARATIONS * 6)
        throw new Error("Long-repetition benchmark lost its declarations");
      return { tokens };
    },
  };
}
