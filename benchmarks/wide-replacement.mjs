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

/**
 * How many names the replacement is written with. Each is two nodes in the
 * run -- the name and the `+` in front of it -- so the walk reads about twice
 * this many.
 *
 * A parameter rather than a literal, because what this scenario is for is a
 * cost that grows faster than the run does: at 2,000 the rules that walk a run
 * to decide what it is cost about four times what they cost at 1,000, not
 * twice.
 */
const NAMES = 2_000;

/**
 * One macro whose replacement is thousands of tokens nothing has parsed.
 *
 * Every other expansion scenario is small files of already-parsed statements,
 * so the longest run the shared rules ever see is about ten nodes. The rules
 * that walk a run -- the width scans, the angle balancers, the collectors that
 * look for binders in a region -- are quadratic in the length of that run, and
 * at ten nodes a quadratic and a linear rule are the same number. A change
 * that made one of them copy its input would be invisible in every other
 * scenario and ruinous on a real macro.
 *
 * The replacement is a chain of distinct names because a name is what the
 * expander has to look up: it asks, for each one, whether it is a macro here,
 * which is the question the region scans answer.
 */
export function defineWideReplacementBenchmark() {
  const names = Array.from(
    { length: NAMES },
    (_, index) => `value${String(index)}`,
  );
  const definitionText = `export syntax wide:expr {\n  rule { wide } => { ${names.join(" + ")} }\n}\n`;
  return {
    id: "expansion/wide-replacement",
    description: `Expand one macro whose replacement is ${String(NAMES)} unparsed names`,
    run() {
      const origins = new OriginStore();
      const scopes = new ScopeStore();
      const phase = createPhase(1);
      const definitionScopes = scopes.singleton(
        scopes.freshScope("module", "wide-definition"),
      );
      const definitionRead = readSyntax(definitionText, {
        sourceId: 40,
        scopes: definitionScopes,
        originStore: origins,
      });
      const parsed = parseMacroDefinitions(definitionRead.root, {
        sourceId: 40,
      });
      const bindingIds = createIdAllocator(1_000);
      const syntaxIds = createIdAllocator(100_000);
      const invocationIds = createIdAllocator(1);
      const module = compileParsedMacros(parsed, {
        sourceId: 40,
        phase,
        definitionScopes,
        allocateBindingId: bindingIds.allocate,
        spanForOrigin: (origin) =>
          origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
      });
      if (definitionRead.diagnostics.length || module.diagnostics.length)
        throw new Error("Wide-replacement benchmark macro did not compile");
      const tracker = new ResourceTracker(createResourceBudget());
      const session = createExpansionFrontendSession({
        module,
        sourceId: 41,
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
      const read = readSyntax("wide", {
        sourceId: 41,
        scopes: scopes.singleton(scopes.freshScope("lexical", "wide-use")),
        originStore: origins,
      });
      const invocation = read.root.children.filter(
        (node) => node.tag !== "token" || node.kind !== "end-of-file",
      );
      const result = session.expand(invocation, "expr");
      if (result.diagnostics.length > 0)
        throw new Error("Wide-replacement benchmark produced diagnostics");
      let tokens = 0;
      const count = (node) => {
        if (node.tag === "token") tokens += 1;
        else for (const child of node.children) count(child);
      };
      for (const node of result.syntax) count(node);
      if (tokens < NAMES)
        throw new Error("Wide-replacement benchmark lost its replacement");
      return { tokens };
    },
  };
}
