import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
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
  createSyntaxSequence,
  OriginStore,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  createExpansionFrontendSession,
  ExpansionGuard,
} from "../src/index.js";

const definitionSource = 991 as SourceId;
const invocationSource = 992 as SourceId;

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(syntax: readonly Syntax[]) {
  return printLosslessSequence(syntax).replace(/\s+/gu, "");
}

function harness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("module", "frontend-definitions"),
  );
  const definitions = readSyntax(
    `
      export syntax twice:expr {
        rule { twice($value:tt) } => { [$value, $value] }
      }
      export syntax guard:stmt {
        rule { guard($condition:expr) $body:stmt }
        => { return; }
      }
      export syntax makeAnswer:item {
        rule { makeAnswer } => { export const answer = 42; }
      }
      export syntax define:item {
        rule { define $name:ident; } => {
          #syntax {
            syntax $name:expr { rule { $name! } => { 42 } }
          }
        }
      }
      export syntax maybe:type {
        rule { maybe<$value:type> } => { $value | undefined }
      }
      export operator (|>):expr {
        fixity infix;
        associativity left;
        precedence 40;
        rule { $value:expr |> $callee:ident } => { $callee($value) }
      }
    `,
    {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    },
  );
  const parsed = parseMacroDefinitions(definitions.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(70_000);
  const bindingIds = createIdAllocator<BindingId>(70_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const phase = createPhase(1);
  const module = compileParsedMacros(parsed, {
    sourceId: definitionSource,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(definitions.diagnostics).toEqual([]);
  expect(parsed.diagnostics).toEqual([]);
  expect(module.diagnostics).toEqual([]);
  const tracker = new ResourceTracker(createResourceBudget());
  const session = createExpansionFrontendSession({
    module,
    sourceId: invocationSource,
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
  return (source: string, category: "expr" | "stmt" | "item" | "type") => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "frontend-use")),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    return session.expand(withoutEof(read.root.children), category);
  };
}

describe("production expansion frontend session", () => {
  test("assembles expression, statement, item, and type categories", () => {
    const expand = harness();
    const expression = expand("twice(21)", "expr");
    const statement = expand("guard(ok) { run(); }", "stmt");
    const item = expand("makeAnswer", "item");
    const type = expand("maybe<string>", "type");
    const sourceFile = expand(
      `export const values: maybe<number[]> = twice(21);
       export const piped = 21 |> double;
       export function checked(ok: boolean) { guard(ok) { work(); } }`,
      "item",
    );

    expect(expression.diagnostics).toEqual([]);
    expect(statement.diagnostics).toEqual([]);
    expect(item.diagnostics).toEqual([]);
    expect(type.diagnostics).toEqual([]);
    expect(sourceFile.diagnostics).toEqual([]);
    expect(compact(expression.syntax)).toBe("[21,21]");
    expect(compact(statement.syntax)).toBe("return;");
    expect(compact(item.syntax)).toBe("exportconstanswer=42;");
    expect(compact(type.syntax)).toBe("string|undefined");
    expect(compact(sourceFile.syntax)).toBe(
      "exportconstvalues:number[]|undefined=[21,21];exportconstpiped=double(21);exportfunctionchecked(ok:boolean){return;}",
    );
    expect(expression.traces).toHaveLength(1);
    expect(statement.traces).toHaveLength(1);
    expect(item.traces).toHaveLength(1);
    expect(type.traces).toHaveLength(1);
  });

  test("dispatches lexical custom operators through the production session", () => {
    const result = harness()("21 |> double", "expr");

    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe("double(21)");
    expect(result.traces).toHaveLength(1);
  });

  /**
   * A statement macro under an annotation ending in `asserts` still expands.
   *
   * `asserts` heads a type predicate only where the name it is about is
   * written on its line. Read as an unconditional operand head, the annotation
   * ran on into the statement below and took the invocation with it -- which
   * reached the output as written, with nothing reported. The control is the
   * same function with an ordinary annotation, and the assertion that matters
   * is the expansion rather than the absence of a diagnostic: there was no
   * diagnostic either way.
   */
  test.each(["number", "asserts"])(
    "expands a statement macro under a `%s` annotation",
    (annotation) => {
      const expand = harness();
      const result = expand(
        `export function f(ok: boolean) {\n  let a: ${annotation}\n  guard(ok) { run(); }\n}`,
        "item",
      );

      expect(result.diagnostics).toEqual([]);
      expect(compact(result.syntax)).toBe(
        `exportfunctionf(ok:boolean){leta:${annotation}return;}`,
      );
    },
  );

  /**
   * An item the reader could not read says so.
   *
   * Recovery passes such an item through as written and expansion carries on,
   * which is how a macro written after its first operand reaches the expander
   * at all -- and also how a declaration the reader disagrees with TypeScript
   * about reached the output in silence. Every item-level parse bug found so
   * far was invisible for exactly that reason.
   */
  test("says what it could not read when a recovered item expanded nothing", () => {
    // `y?.<A>` is an optional chain with type arguments and no call after
    // them, which TypeScript reports as `'(' expected` and this reader
    // refuses. Nothing in the declaration is macro syntax, so recovery bought
    // nothing here and nothing else reports it.
    //
    // The fixture keeps moving because the gaps keep closing: the
    // instantiation expression `y<A>` stood here, then `y?.<A>(b)`, and both
    // read now. This one is the first that is unreadable because TypeScript
    // does not accept it either -- no valid TypeScript is known to be
    // unreadable at this point, which is why the sample is malformed rather
    // than merely uncovered.
    const result = harness()("export const x = y?.<A>;", "item");

    expect(
      result.diagnostics.map(({ code, severity }) => ({ code, severity })),
    ).toEqual([{ code: "SWR4025", severity: "warning" }]);
    const reported = result.diagnostics[0];
    if (reported === undefined) throw new Error("expected a diagnostic");
    expect(reported.messageArguments).toEqual(["variable initializer"]);
    expect(reported.relatedOrigins).toHaveLength(1);
    // The whole item is named, and the place the reader stopped is named
    // under it.
    expect(reported.primaryOrigin.start).toBe(0);
    expect(reported.primaryOrigin.end).toBe("export const x = y?.<A>;".length);
    expect(reported.relatedOrigins[0]?.origin.start).toBeGreaterThan(
      reported.primaryOrigin.start,
    );
  });

  /**
   * A recovery that did its job says nothing. The reader is not meant to read
   * an operator's operands or a macro written after its first one, so a word
   * on every recovery would be a word on most files that use macros.
   */
  test.each([
    // An operator in an initializer: the declaration is recovered and the
    // expander goes on to expand it.
    "export const piped = 21 |> double;",
    // An item macro's own expansion replaces the item.
    "makeAnswer",
  ])("says nothing about the recovery that expanded %j", (source) => {
    expect(harness()(source, "item").diagnostics).toEqual([]);
  });

  /**
   * A run that does not begin where a declaration begins is not a declaration
   * the reader got wrong -- it is syntax written in some other shape, and
   * TypeScript reports it if it is not a program at all.
   */
  test("says nothing about a recovered run that begins no declaration", () => {
    expect(harness()("Box holds 1;", "item").diagnostics).toEqual([]);
  });

  test("registers and invokes a generated expression macro later in the file", () => {
    const result = harness()(
      "define answer; export const result = answer!;",
      "item",
    );

    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe("exportconstresult=42;");
    expect(result.generatedDefinitionTraces).toHaveLength(1);
    expect(result.traces).toHaveLength(2);
  });
});
