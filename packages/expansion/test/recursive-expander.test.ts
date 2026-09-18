import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { createSyntaxClassConsumer } from "@sweetener/pattern";
import { readSyntax, printLosslessSequence } from "@sweetener/reader";
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
} from "@sweetener/syntax";
import {
  createBindingConsumer,
  createPrattExpressionConsumer,
  type ConsumerContext,
} from "@sweetener/enforestation";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  expandMacroSyntax,
  ExpansionGuard,
} from "../src/index.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const definitionSource = 501 as SourceId;
const invocationSource = 502 as SourceId;
const phase = createPhase(1);

describe("recursive declarative expansion", () => {
  test("expands sequential do bindings through the public compiler and invocation path", async () => {
    const definitionText = await readFile(
      path.join(
        repositoryRoot,
        "fixtures/acceptance/playground/do-notation/declarative.sts",
      ),
      "utf8",
    );
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("lexical", "do-definition"),
    );
    const parsed = parseMacroDefinitions(
      readSyntax(definitionText, {
        sourceId: definitionSource,
        scopes: definitionScopes,
        originStore: origins,
      }).root,
      { sourceId: definitionSource },
    );
    const bindingIds = createIdAllocator<BindingId>(1_000);
    const module = compileParsedMacros(parsed, {
      sourceId: definitionSource,
      phase,
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(module.diagnostics).toEqual([]);

    const syntaxIds = createIdAllocator<SyntaxId>(20_000);
    const invocationIds = createIdAllocator<InvocationId>(1);
    const tracker = new ResourceTracker(createResourceBudget());
    const guard = new ExpansionGuard({ tracker });
    const expression = createPrattExpressionConsumer({
      allocateSyntaxId: syntaxIds.allocate,
      origins,
    });
    const binding = createBindingConsumer({
      allocateSyntaxId: syntaxIds.allocate,
      origins,
    });
    const context = (category: "expr" | "binding"): ConsumerContext => ({
      category,
      phase,
      environmentEpoch: 0 as Parameters<
        typeof expandMacroSyntax
      >[0]["environmentEpoch"],
      stopSet: awaitStopSet as never,
      tracker,
      cancellation: guard.cancellation,
      allowYield: false,
      allowAwait: false,
    });
    const builtins = {
      token: module.classId("token")!,
      tt: module.classId("tt")!,
      ident: module.classId("ident")!,
    };
    const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
      builtins,
      tracker,
      environmentEpoch: 0,
      externalConsumer: (classId, cursor) => {
        const category =
          classId === module.classId("expr")
            ? "expr"
            : classId === module.classId("binding")
              ? "binding"
              : undefined;
        if (category === undefined) return undefined;
        const start = cursor.index;
        const attempt = (category === "expr" ? expression : binding).consume(
          cursor,
          context(category),
        );
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
    const read = readSyntax(
      "doSteps(box) { left <- box.of(2); right <- box.of(3); return left + right; }",
      {
        sourceId: invocationSource,
        scopes: scopes.singleton(scopes.freshScope("lexical", "callsite")),
        originStore: origins,
      },
    );
    const input = createSyntaxSequence(
      read.root.children.filter(
        (node) => node.tag !== "token" || node.kind !== "end-of-file",
      ),
    );
    const environments = new EnvironmentStore();
    const environment = environments.createRoot();
    const expanded = expandMacroSyntax({
      module,
      syntax: input,
      category: "expr",
      consumeClass,
      phase,
      environmentEpoch: environment.epoch,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      enforest: ({ syntax, category }) => {
        if (category !== "expr") throw new TypeError("expected expression");
        const attempt = expression.consume(
          createSyntaxCursor(syntax),
          context("expr"),
        );
        if (!attempt.matched || !attempt.cursor.atEnd) {
          throw new TypeError("expanded syntax is not one expression");
        }
        return attempt.syntax;
      },
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: () => true,
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
    expect(expanded.diagnostics).toEqual([]);
    expect(expanded.traces).toHaveLength(3);
    expect(expanded.traces.map(({ selectedRule }) => selectedRule)).toEqual([
      module.get("doSteps", "expr")!.rules[2]!.rule,
      module.get("doSteps", "expr")!.rules[2]!.rule,
      module.get("doSteps", "expr")!.rules[0]!.rule,
    ]);
    expect(printLosslessSequence(expanded.syntax).replace(/\s+/gu, "")).toBe(
      "box.flatMap(box.of(2),(left)=>box.flatMap(box.of(3),(right)=>box.of(left+right)))",
    );
  });
});

// Kept outside the test body so the consumer context shares one immutable stop set.
import { StopSet } from "@sweetener/enforestation";
const awaitStopSet = StopSet.empty;
