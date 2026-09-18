import {
  createPrattExpressionConsumer,
  StopSet,
  type ConsumerContext,
} from "@sweetener/enforestation";
import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { createSyntaxClassConsumer } from "@sweetener/pattern";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type InvocationId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createSyntaxCursor,
  createSyntaxSequence,
  OriginStore,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  expandMacroSyntax,
  ExpansionGuard,
} from "../src/index.js";

const definitionSource = 610 as SourceId;
const invocationSource = 611 as SourceId;
const phase = createPhase(1);

const definitions = `
  export syntax checkif:expr {
    rule {
      checkif($value:expr)
      isbetween($low:expr)
      and($high:expr)
    }
    expect "and upper-bound segment"
    => { within($value, $low, $high) }

    rule {
      checkif($value:expr)
      isbetween($low:expr)
      or($high:expr)
    }
    expect "or upper-bound segment"
    => { outside($value, $low, $high) }
  }

  export syntax self:expr {
    rule { self($value:expr) } => { #core(self($value)) }
  }
`;

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function createHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "mixfix-definition"),
  );
  const parsed = parseMacroDefinitions(
    readSyntax(definitions, {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    }).root,
    { sourceId: definitionSource },
  );
  const syntaxIds = createIdAllocator<SyntaxId>(90_000);
  const bindingIds = createIdAllocator<BindingId>(90_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const module = compileParsedMacros(parsed, {
    sourceId: definitionSource,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(module.diagnostics).toEqual([]);
  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const expression = createPrattExpressionConsumer({
    origins,
    allocateSyntaxId: syntaxIds.allocate,
  });
  const context: ConsumerContext = {
    category: "expr",
    phase,
    environmentEpoch: 0 as Parameters<
      typeof expandMacroSyntax
    >[0]["environmentEpoch"],
    stopSet: StopSet.empty,
    tracker,
    cancellation: guard.cancellation,
    allowYield: false,
    allowAwait: false,
  };
  const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
    builtins: {
      token: module.classId("token")!,
      tt: module.classId("tt")!,
      ident: module.classId("ident")!,
    },
    tracker,
    environmentEpoch: context.environmentEpoch,
    externalConsumer: (classId, cursor) => {
      if (classId !== module.classId("expr")) return undefined;
      const start = cursor.index;
      const attempt = expression.consume(cursor, context);
      if (!attempt.matched) return undefined;
      const syntax = cursor
        .remainingRange()
        .sequence.slice(start, attempt.cursor.index);
      return {
        cursor: attempt.cursor,
        syntax: createSyntaxSequence(syntax),
        origin: syntax[0]!.origin,
      };
    },
  });
  const hygieneEnvironments = new EnvironmentStore();
  const environment = hygieneEnvironments.createRoot();
  const expand = (source: string) => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "mixfix-call")),
      originStore: origins,
    });
    return expandMacroSyntax({
      module,
      syntax: withoutEof(read.root.children),
      category: "expr",
      consumeClass,
      phase,
      environmentEpoch: environment.epoch,
      scopeStore: scopes,
      origins,
      environments: hygieneEnvironments,
      environment,
      tracker,
      guard,
      enforest: ({ syntax, category }) => {
        if (category !== "expr") throw new TypeError("expected expression");
        const attempt = expression.consume(createSyntaxCursor(syntax), context);
        if (!attempt.matched || !attempt.cursor.atEnd)
          throw new TypeError(
            `expanded syntax is not one expression at ${attempt.matched ? attempt.cursor.index : attempt.failure.expectations.join(",")}: ${printLosslessSequence(syntax)}`,
          );
        return attempt.syntax;
      },
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: ({ cursor }) => cursor.atEnd,
      diagnosticOrigin: (origin) => {
        const selected = origins.selectPrimarySource(origin)!;
        return {
          sourceId: selected.sourceId,
          start: selected.span.start,
          end: selected.span.end,
          originId: origin,
        };
      },
    });
  };
  return { expand, module };
}

function compact(syntax: readonly Syntax[]) {
  return printLosslessSequence(syntax).replace(/\s+/gu, "");
}

describe("mixfix composition", () => {
  test("matches newline-spanning segments with nested TypeScript calls", () => {
    const { expand } = createHarness();
    const result = expand(`
      checkif(compute(2))
        isbetween(lower(1))
        and(upper(4))
    `);
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe("within(compute(2),lower(1),upper(4))");
    expect(result.traces).toHaveLength(1);
  });

  test("selects the literal segment alternative without a mixfix registry", () => {
    const { expand, module } = createHarness();
    const result = expand("checkif(value) isbetween(low) or(high)");
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe("outside(value,low,high)");
    expect(result.traces[0]?.selectedRule).toBe(
      module.get("checkif", "expr")!.rules[1]!.rule,
    );
  });

  test("ranks competing missing-segment failures at the farthest boundary", () => {
    const { expand } = createHarness();
    const result = expand("checkif(value) isbetween(low) xor(high)");
    expect(compact(result.syntax)).toBe(
      "checkif(value)isbetween(low)xor(high)",
    );
    expect(result.diagnostics).toMatchObject([
      {
        code: "SWR4001",
        messageArguments: [
          "checkif",
          expect.stringMatching(/upper-bound segment/u),
        ],
      },
    ]);
    expect(result.traces[0]?.attemptedRules).toMatchObject([
      { status: "no-match" },
      { status: "no-match" },
    ]);
  });

  test("uses #core to suppress dispatch of the emitted head", () => {
    const { expand } = createHarness();
    const result = expand("self(value)");
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe("self(value)");
    expect(result.traces).toHaveLength(1);
  });
});
