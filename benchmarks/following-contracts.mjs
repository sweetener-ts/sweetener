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

/** How many invocations bind a name in what follows them, in each list. */
const INVOCATIONS = 1_000;

/**
 * A module of item macros, and a function body of statement macros, each of
 * which binds the name it is given in the syntax after it.
 *
 * Every such binding is visible from its invocation to the end of the block
 * or module, so the syntax after it has to carry the scope that binding is
 * declared with. A scope of its own for each invocation, given to everything
 * after it as it expanded, cost the square of the list in scopes on every
 * later token and its cube in time: two thousand invocations took three
 * minutes. The invocations of one block share its scope, so the list costs
 * what its length does.
 */
export function defineFollowingContractsBenchmark() {
  const definitionText = `export syntax bindItem:item {
  rule { bindItem $name:binding; }
  bind $name in following as recursive value;
  => { export const $name = 1; }
}
export syntax bindLocal:stmt {
  rule { bindLocal $name:binding; }
  bind $name in following as lexical value;
  => { const $name = 1; }
}
`;
  const names = Array.from(
    { length: INVOCATIONS },
    (_, index) => `value${String(index)}`,
  );
  const sourceText = [
    ...names.map((name) => `bindItem ${name};`),
    "export function body() {",
    ...names.map((name) => `bindLocal ${name};`),
    "}",
  ].join("\n");
  return {
    id: "expansion/following-contracts",
    description: `Expand ${String(INVOCATIONS)} item and ${String(INVOCATIONS)} statement macros that each bind in following syntax`,
    run() {
      const origins = new OriginStore();
      const scopes = new ScopeStore();
      const phase = createPhase(1);
      const definitionScopes = scopes.singleton(
        scopes.freshScope("module", "following-definition"),
      );
      const definitionRead = readSyntax(definitionText, {
        sourceId: 50,
        scopes: definitionScopes,
        originStore: origins,
      });
      const parsed = parseMacroDefinitions(definitionRead.root, {
        sourceId: 50,
      });
      const bindingIds = createIdAllocator(1_000);
      const syntaxIds = createIdAllocator(100_000);
      const invocationIds = createIdAllocator(1);
      const module = compileParsedMacros(parsed, {
        sourceId: 50,
        phase,
        definitionScopes,
        allocateBindingId: bindingIds.allocate,
        spanForOrigin: (origin) =>
          origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
      });
      if (definitionRead.diagnostics.length || module.diagnostics.length)
        throw new Error("Following-contracts benchmark macros did not compile");
      const tracker = new ResourceTracker(createResourceBudget());
      const session = createExpansionFrontendSession({
        module,
        sourceId: 51,
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
        sourceId: 51,
        scopes: scopes.singleton(scopes.freshScope("module", "following-use")),
        originStore: origins,
      });
      const items = read.root.children.filter(
        (node) => node.tag !== "token" || node.kind !== "end-of-file",
      );
      const result = session.expand(items, "item");
      if (result.diagnostics.length > 0)
        throw new Error("Following-contracts benchmark produced diagnostics");
      if (result.traces.length !== 2 * INVOCATIONS)
        throw new Error("Following-contracts benchmark skipped an invocation");
      return { invocations: result.traces.length };
    },
  };
}
