import { createPhase } from "@sweetener/hygiene";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type EnvironmentEpoch,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createPrecedence,
  createProtectedSyntax,
  createSyntaxCursor,
  OriginStore,
  type ProtectedSyntax,
  type Syntax,
} from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  coreExpressionOperators,
  createConsumerSuite,
  StopSet,
  type MacroOperatorExpansionInput,
  type MacroOperatorResolver,
} from "../src/index.js";

const sourceId = 89 as SourceId;

function parse(
  source: string,
  resolveMacroOperator?: MacroOperatorResolver,
  allowComma = false,
  // Read as though inside an async generator, so `yield` and `await` parse
  // like any other prefix operator; a caller testing where each is an
  // expression says so for itself.
  contexts: { readonly allowYield: boolean; readonly allowAwait: boolean } = {
    allowYield: true,
    allowAwait: true,
  },
) {
  const origins = new OriginStore();
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
  });
  expect(read.diagnostics).toEqual([]);
  const syntax = read.root.children.filter(
    (node) => node.tag !== "token" || node.kind !== "end-of-file",
  );
  const ids = createIdAllocator<SyntaxId>(20_000);
  // Wired as the expander wires it. Built alone the expression consumer has no
  // `consumeType`, so `x as string[]` does not parse and the harness reports a
  // gap the pipeline does not have.
  const { registry } = createConsumerSuite({
    origins,
    allocateSyntaxId: () => ids.allocate(),
    resolveMacroOperator,
    allowComma,
  });
  const cursor = createSyntaxCursor(syntax);
  const result = registry.consume("expr", {
    cursor,
    phase: createPhase(0),
    environmentEpoch: 0 as EnvironmentEpoch,
    tracker: new ResourceTracker(createResourceBudget()),
    allowYield: contexts.allowYield,
    allowAwait: contexts.allowAwait,
  });
  return { result, cursor, origins, syntax, ids };
}

function output(source: string, resolver?: MacroOperatorResolver): string {
  const { result } = parse(source, resolver);
  if (!result.matched) {
    throw new Error(result.failure.expectations.join(", "));
  }
  return printLosslessSequence(result.syntax.children);
}

function operatorAt(syntax: ProtectedSyntax, index = 1): string | undefined {
  const child = syntax.children[index];
  return child?.tag === "token" ? child.raw : undefined;
}

describe("Pratt expression consumer", () => {
  test("consumes TypeScript generic calls as primary postfix expressions", () => {
    const { result } = parse("useState<number>(0)");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected generic call expression");
    expect(result.cursor.atEnd).toBe(true);
  });
  /**
   * `y?.<A>(b)` is an optional call with its type arguments supplied.
   * TypeScript writes `?. TypeArguments Arguments`, so the call is part of the
   * form and `y?.<A>` on its own is reported by TypeScript too. Read as
   * nothing an optional chain may hold, the declaration this stood in
   * recovered to its tokens, and a macro at a statement head inside it went
   * unexpanded with nothing said.
   */
  test.each([
    "y?.<A>(b)",
    "y?.<A, B>(b)",
    "y?.<A>`t`",
    "a?.b?.<A>(c)",
    "a?.<A>(b)!.c",
  ])("consumes an optional call with type arguments: %s", (source) => {
    const { result } = parse(source);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected an optional call");
    expect(result.cursor.atEnd).toBe(true);
    expect(output(source)).toBe(source);
  });

  test("refuses type arguments in an optional chain with no call after them", () => {
    // TypeScript reports `'(' expected` here, so refusing agrees with it.
    const { result } = parse("y?.<A>");
    expect(result.matched).toBe(false);
  });

  test("consumes generic arrows with explicit return types", () => {
    const source = '<T>(value: T): Option<T> => ({ tag: "Some", value })';
    const { result } = parse(source);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected generic arrow expression");
    expect(result.cursor.atEnd).toBe(true);
    expect(output(source)).toBe(source);
  });
  test("rejoins operators the reader splits after a leading angle bracket", () => {
    // `>` is scanned on its own so nested type arguments close, which leaves
    // every `>`-led operator arriving as separate adjacent tokens.
    for (const source of [
      "a >= b",
      "a >> b",
      "a >>> b",
      "a >>= b",
      "a >>>= b",
    ]) {
      const { result } = parse(source);
      expect(result.matched, source).toBe(true);
      if (!result.matched) continue;
      // Unless the operator is rejoined, the consumer stops at the first `>`
      // and leaves the rest of the expression unconsumed.
      expect(result.cursor.atEnd, source).toBe(true);
      expect(output(source), source).toBe(source);
    }
  });

  test("stops at a greater-than that closes type arguments", () => {
    const source = "new Map<string, Set<number>>()";
    const { result } = parse(source);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a generic construction");
    expect(result.cursor.atEnd).toBe(true);
    expect(output(source)).toBe(source);
  });

  test("publishes one deterministic entry per core fixity and spelling", () => {
    const keys = coreExpressionOperators.map(
      ({ fixity, spelling }) => `${fixity}|${spelling}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("infix|**");
    expect(keys).toContain("infix|??=");
    expect(keys).toContain("prefix|typeof");
    expect(keys).toContain("postfix|++");
    expect(Object.isFrozen(coreExpressionOperators)).toBe(true);
  });

  test.each([
    "a + b * c",
    "a * b + c",
    "a ** b ** c",
    "a - b - c",
    "a && b || c",
    "a ?? b",
    "a ? b + c : d * e",
    "a = b = c",
    "a += b * c",
    "x => x + 1",
    "import('./module.js')",
    "import.meta.url",
    "class Named { method() { return 1; } }",
    "function <T>(value: T): T { return value; }",
    "new.target",
    "typeof value === 'string'",
    "new Factory().value",
    "++counter + value--",
    "value as Model",
    "value satisfies Model",
  ])("consumes full core expression losslessly: %s", (source) => {
    expect(output(source)).toBe(source);
  });

  test("builds left- and right-associative trees from binding powers", () => {
    const left = parse("a - b - c").result;
    if (!left.matched) throw new Error("expected subtraction");
    expect(operatorAt(left.syntax)).toBe("-");
    const leftOperand = left.syntax.children[0];
    expect(leftOperand?.tag).toBe("protected");
    expect(operatorAt(leftOperand as ProtectedSyntax)).toBe("-");

    const right = parse("a = b = c").result;
    if (!right.matched) throw new Error("expected assignment");
    expect(operatorAt(right.syntax)).toBe("=");
    const rightOperand = right.syntax.children[2];
    expect(rightOperand?.tag).toBe("protected");
    expect(operatorAt(rightOperand as ProtectedSyntax)).toBe("=");
  });

  test("keeps conditional branches at their required precedence", () => {
    const result = parse("test ? yes, also : no = fallback").result;
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(operatorAt(result.syntax)).toBe("?");
    expect(operatorAt(result.syntax.children[2] as ProtectedSyntax)).toBe(",");
    expect(operatorAt(result.syntax.children[4] as ProtectedSyntax)).toBe("=");
    expect(output("test ? yes, also : no = fallback")).toBe(
      "test ? yes, also : no = fallback",
    );
  });

  /**
   * A conditional written as an arrow's concise body keeps its own `:`. The
   * arrow was measured by stopping at the first `:` beside its body, so the
   * alternate fell outside the arrow: `(v) => v ? 1 : 2` was read as
   * `(v) => v ? 1` with `: 2` left for whatever held it.
   */
  test.each([
    "(v) => v ? 1 : 2",
    "async (v) => v ? 1 : 2",
    "(v: number): number => v ? 1 : 2",
    "(v) => v ? a ? b : c : d",
    "(v) => v ? (a) => a : (b) => b",
    // The arrow is a conditional's consequent, so the `:` after its body is
    // that conditional's and ends the body, while the `:` of the conditional
    // written inside the body is the body's own.
    "c ? (v) => v ? 1 : 2 : d",
    "c ? (x) => x : d",
    "[(v) => v ? 1 : 2, 3]",
  ])("reads %s whole", (source) => {
    const { result } = parse(source);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(result.cursor.atEnd).toBe(true);
    const transpiled = ts.transpileModule(`const result = ${source};`, {
      compilerOptions: { strict: false, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(
      (transpiled.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ),
    ).toEqual([]);
  });

  test("rejects yield when the lexical context is not a generator", () => {
    const origins = new OriginStore();
    const read = readSyntax("yield value", {
      sourceId,
      scopes: 0 as ScopeSetId,
      originStore: origins,
    });
    const syntax = read.root.children.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    );
    const { registry } = createConsumerSuite({
      origins,
      allocateSyntaxId: createIdAllocator<SyntaxId>(25_000).allocate,
    });
    const rejected = registry.consume("expr", {
      cursor: createSyntaxCursor(syntax),
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: false,
      allowAwait: false,
    });
    expect(rejected.matched).toBe(false);
    if (rejected.matched) throw new Error("yield unexpectedly matched");
    expect(rejected.failure.expectations).toEqual(["yield inside a generator"]);
    const accepted = registry.consume("expr", {
      cursor: createSyntaxCursor(syntax),
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: true,
      allowAwait: false,
    });
    expect(accepted.matched).toBe(true);
  });

  test("rejects await when the lexical context is not async", () => {
    const origins = new OriginStore();
    const read = readSyntax("await value", {
      sourceId,
      scopes: 0 as ScopeSetId,
      originStore: origins,
    });
    const syntax = read.root.children.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    );
    const { registry } = createConsumerSuite({
      origins,
      allocateSyntaxId: createIdAllocator<SyntaxId>(26_000).allocate,
    });
    const rejected = registry.consume("expr", {
      cursor: createSyntaxCursor(syntax),
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: false,
      allowAwait: false,
    });
    expect(rejected.matched).toBe(false);
    if (rejected.matched) throw new Error("await unexpectedly matched");
    expect(rejected.failure.expectations).toEqual([
      "await inside an async function",
    ]);
    const accepted = registry.consume("expr", {
      cursor: createSyntaxCursor(syntax),
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: false,
      allowAwait: true,
    });
    expect(accepted.matched).toBe(true);
  });

  test("uses assignment-expression extent by default at comma boundaries", () => {
    const result = parse("first, second").result;
    if (!result.matched) throw new Error("expected first expression");
    expect(printLosslessSequence(result.syntax.children)).toBe("first");
    expect(result.cursor.peek()).toMatchObject({ raw: "," });
    const full = parse("first, second", undefined, true).result;
    if (!full.matched) throw new Error("expected comma expression");
    expect(printLosslessSequence(full.syntax.children)).toBe("first, second");
    expect(full.cursor.atEnd).toBe(true);
  });

  test.each([
    ["a +", "identifier, literal"],
    ["!", "identifier, literal"],
    ["test ? yes", "':' in conditional"],
    ["test ? : no", "identifier, literal"],
    ["value++++", "repeated postfix"],
    ["-value ** power", "unary expression before '**'"],
    ["a ?? b || c", "mixing '??'"],
    ["a && b ?? c", "mixing '??'"],
  ])(
    "rejects malformed or parenthesis-sensitive expression %s",
    (source, expected) => {
      const { result, cursor } = parse(source);
      expect(result.matched).toBe(false);
      if (result.matched) throw new Error("expected failure");
      expect(result.failure.expectations.join(" ")).toContain(expected);
      expect(cursor.index).toBe(0);
    },
  );

  test("does not consume postfix updates across a line break", () => {
    const { result } = parse("value\n++next");
    if (!result.matched) throw new Error("expected first expression");
    expect(printLosslessSequence(result.syntax.children)).toBe("value");
    expect(result.cursor.peek()).toMatchObject({ raw: "++" });
  });

  test("expands a multi-token nonassociative macro operator through the hook", () => {
    let expansions = 0;
    const origins = new OriginStore();
    const ids = createIdAllocator<SyntaxId>(30_000);
    const resolver: MacroOperatorResolver = (cursor, fixity) => {
      const first = cursor.peek();
      const second = cursor.peek(1);
      const width =
        first?.tag === "token" && first.raw === "|>"
          ? 1
          : first?.tag === "token" &&
              second?.tag === "token" &&
              `${first.raw}${second.raw}` === "|>"
            ? 2
            : 0;
      if (fixity !== "infix" || width === 0) return undefined;
      return Object.freeze({
        binding: 700 as BindingId,
        spelling: "|>",
        fixity: "infix",
        precedence: 125,
        associativity: "none",
        width,
        expand: ({ left, operator, right }: MacroOperatorExpansionInput) => {
          expansions += 1;
          const children: Syntax[] = [left!, ...operator, right!];
          return createProtectedSyntax({
            id: ids.allocate(),
            span: {
              start: children[0]!.span.start,
              end: children.at(-1)!.span.end,
            },
            origin: origins.composed([
              ...new Set(children.map(({ origin }) => origin)),
            ]),
            scopes: children[0]!.scopes,
            category: "expr",
            precedence: createPrecedence(125),
            children,
          });
        },
      });
    };
    // Use the parse helper's origin store inside expansion by deriving the origin
    // from operands when the test-local store does not own them.
    const safeResolver: MacroOperatorResolver = (cursor, fixity, context) => {
      const candidate = resolver(cursor, fixity, context);
      if (candidate === undefined) return undefined;
      return Object.freeze({
        ...candidate,
        expand: ({
          left,
          operator,
          right,
          context: expansionContext,
        }: MacroOperatorExpansionInput) => {
          expansions += 1;
          const children: Syntax[] = [left!, ...operator, right!];
          return createProtectedSyntax({
            id: ids.allocate(),
            span: {
              start: children[0]!.span.start,
              end: children.at(-1)!.span.end,
            },
            origin: children[0]!.origin,
            scopes: children[0]!.scopes,
            category: expansionContext.category,
            precedence: createPrecedence(125),
            children,
          });
        },
      });
    };
    expect(output("value |> transform", safeResolver)).toBe(
      "value |> transform",
    );
    expect(expansions).toBe(1);
    const repeated = parse("a |> b |> c", safeResolver).result;
    expect(repeated.matched).toBe(false);
    if (!repeated.matched) {
      expect(repeated.failure.expectations.join(" ")).toContain(
        "nonassociative '|>'",
      );
    }
  });

  test("requires explicit authorization before a macro operator replaces core syntax", () => {
    let expansions = 0;
    const ids = createIdAllocator<SyntaxId>(35_000);
    const resolver =
      (shadowsCore: boolean): MacroOperatorResolver =>
      (cursor, fixity) => {
        const first = cursor.peek();
        if (fixity !== "infix" || first?.tag !== "token" || first.raw !== "+")
          return undefined;
        return Object.freeze({
          binding: 701 as BindingId,
          spelling: "+",
          fixity: "infix" as const,
          precedence: 130,
          associativity: "left" as const,
          width: 1,
          shadowsCore,
          expand: ({
            left,
            operator,
            right,
            context,
          }: MacroOperatorExpansionInput) => {
            expansions += 1;
            const children: Syntax[] = [left!, ...operator, right!];
            return createProtectedSyntax({
              id: ids.allocate(),
              span: {
                start: children[0]!.span.start,
                end: children.at(-1)!.span.end,
              },
              origin: children[0]!.origin,
              scopes: children[0]!.scopes,
              category: context.category,
              precedence: createPrecedence(130),
              children,
            });
          },
        });
      };

    expect(output("left + right", resolver(false))).toBe("left + right");
    expect(expansions).toBe(0);
    expect(output("left + right", resolver(true))).toBe("left + right");
    expect(expansions).toBe(1);
  });

  test.each([
    "a + b * c",
    "a ** b ** c",
    "test ? yes : no",
    "a = b = c",
    "x => x + 1",
    "typeof value === 'string'",
    "new Factory().value",
    "a ?? b",
  ])("matches pinned TypeScript acceptance for %s", (source) => {
    const printed = output(source);
    const transpiled = ts.transpileModule(`const result = (${printed});`, {
      compilerOptions: { strict: true, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(
      (transpiled.diagnostics ?? []).filter(
        ({ category }) => category === ts.DiagnosticCategory.Error,
      ),
    ).toEqual([]);
  });

  test("stops before an external expression boundary", () => {
    const origins = new OriginStore();
    const read = readSyntax("a + b; next", {
      sourceId,
      scopes: 0 as ScopeSetId,
      originStore: origins,
    });
    const syntax = read.root.children.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    );
    const ids = createIdAllocator<SyntaxId>(40_000);
    const { registry } = createConsumerSuite({
      origins,
      allocateSyntaxId: () => ids.allocate(),
    });
    const result = registry.consume("expr", {
      cursor: createSyntaxCursor(syntax),
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      stopSet: new StopSet([{ kind: "token", raw: ";" }]),
      allowYield: false,
      allowAwait: false,
    });
    if (!result.matched) throw new Error("expected expression");
    expect(printLosslessSequence(result.syntax.children)).toBe("a + b");
    expect(result.cursor.peek()).toMatchObject({ raw: ";" });
  });

  test("reads `yield` over a whole assignment expression", () => {
    const result = parse("yield a + b").result;
    if (!result.matched) throw new Error("expected a yield expression");
    expect(result.syntax.form).toBe("yield");
    const operand = result.syntax.children[1] as ProtectedSyntax;
    expect(operatorAt(operand)).toBe("+");
  });

  /**
   * A parenthesized operand at the head of a conditional's consequent.
   *
   * `(x)` there may be the consequent itself, with the conditional's `:` after
   * it and an arrow in the alternate, or a parameter list whose return type is
   * written past that `:`. TypeScript tells them apart by where the arrow ends:
   * a return type reads only when the conditional's own `:` follows the arrow's
   * body. Reading `(x) :` as a parameter list and a return type whatever
   * followed left `c ? (x) : (y) => y` with no `:` for its conditional, and the
   * whole expression was refused.
   */
  test.each([
    [
      "c ? (x) : (y) => y",
      ["c", "?", "(x)", ":", "(y) => y"],
      [undefined, undefined, undefined, undefined, "arrow"],
    ],
    [
      "c ? (x): T => x : y",
      ["c", "?", "(x): T => x", ":", "y"],
      [undefined, undefined, "arrow", undefined, undefined],
    ],
  ])("reads the parts of %s", (source, parts, forms) => {
    const result = parse(source).result;
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(result.syntax.form).toBe("conditional");
    expect(
      result.syntax.children.map((child) =>
        printLosslessSequence([child]).trim(),
      ),
    ).toEqual(parts);
    expect(
      result.syntax.children.map((child) =>
        child.tag === "protected" ? child.form : undefined,
      ),
    ).toEqual(forms);
  });

  test.each([
    ["a ? b : c", "conditional"],
    ["x => x + 1", "arrow"],
    ["(x: number) => x + 1", "arrow"],
    ["async v => v + 1", "arrow"],
    ["async v => { return v; }", "arrow"],
    // An arrow whose one parameter is itself named `async`.
    ["async => async", "arrow"],
    ["a += b", "assignment"],
    ["a ??= b", "assignment"],
    ["yield a", "yield"],
    ["await a", "await"],
    ["(a ? b : c)", undefined],
    ["a + b", undefined],
  ])("records the form of %s", (source, form) => {
    const result = parse(source).result;
    if (!result.matched) throw new Error(result.failure.expectations.join());
    expect(result.syntax.form).toBe(form);
  });

  test("reads a contextual keyword as an operand", () => {
    expect(output("from + of * type")).toBe("from + of * type");
  });

  test("does not reach past a statement for a parenthesized arrow", () => {
    const origins = new OriginStore();
    const read = readSyntax("(a) + b; (c) => d", {
      sourceId,
      scopes: 0 as ScopeSetId,
      originStore: origins,
    });
    const syntax = read.root.children.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    );
    const ids = createIdAllocator<SyntaxId>(50_000);
    const { registry } = createConsumerSuite({
      origins,
      allocateSyntaxId: () => ids.allocate(),
    });
    const result = registry.consume("expr", {
      cursor: createSyntaxCursor(syntax),
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: false,
      allowAwait: false,
    });
    if (!result.matched) throw new Error("expected an expression");
    expect(printLosslessSequence(result.syntax.children)).toBe("(a) + b");
    expect(result.cursor.peek()).toMatchObject({ raw: ";" });
  });

  describe("a macro operator's right operand", () => {
    function pipe(options: {
      readonly literalRightOperands?: readonly (readonly string[])[];
      readonly arrowOperand?: boolean;
    }) {
      const seen: string[] = [];
      const ids = createIdAllocator<SyntaxId>(60_000);
      const resolver: MacroOperatorResolver = (cursor, fixity) => {
        const first = cursor.peek();
        const second = cursor.peek(1);
        if (
          fixity !== "infix" ||
          first?.tag !== "token" ||
          second?.tag !== "token" ||
          first.raw !== "|" ||
          second.raw !== ">" ||
          second.leadingTrivia.length > 0
        )
          return undefined;
        return Object.freeze({
          binding: 800 as BindingId,
          spelling: "|>",
          fixity: "infix",
          precedence: 35,
          associativity: "left",
          width: 2,
          ...options,
          expand: ({ left, operator, right }: MacroOperatorExpansionInput) => {
            seen.push(printLosslessSequence([right!]).trim());
            const children: Syntax[] = [left!, ...operator, right!];
            return createProtectedSyntax({
              id: ids.allocate(),
              span: {
                start: children[0]!.span.start,
                end: children.at(-1)!.span.end,
              },
              origin: children[0]!.origin,
              scopes: children[0]!.scopes,
              category: "expr",
              precedence: createPrecedence(35),
              children,
            });
          },
        });
      };
      return { resolver, seen };
    }

    test("is a literal a rule names only where nothing continues it", () => {
      const { resolver, seen } = pipe({ literalRightOperands: [["await"]] });
      expect(output("p |> await |> f", resolver)).toBe("p |> await |> f");
      expect(seen).toEqual(["await", "f"]);
      seen.length = 0;
      expect(output("p |> await f", resolver)).toBe("p |> await f");
      expect(seen).toEqual(["await f"]);
    });

    test("may be an arrow that ends at the next use of the operator", () => {
      const { resolver, seen } = pipe({ arrowOperand: true });
      expect(output("x |> n => f(n) |> (m) => m + 1 |> g", resolver)).toBe(
        "x |> n => f(n) |> (m) => m + 1 |> g",
      );
      expect(seen).toEqual(["n => f(n)", "(m) => m + 1", "g"]);
    });

    test("is not an arrow unless the operator says so", () => {
      const { resolver } = pipe({});
      const { result } = parse("x |> n => f(n)", resolver);
      if (!result.matched) throw new Error("expected an expression");
      // `=>` binds looser than the pipe, so the pipe becomes its parameters.
      expect(result.syntax.form).toBe("arrow");
      expect(operatorAt(result.syntax)).toBe("=>");
    });
  });
});

/**
 * An arrow written with one unparenthesized parameter.
 *
 * `v => …` is read by the infix `=>`, which protects the name to its left as
 * the parameters. `async v => …` cannot be: `async` and the name are two
 * operands, only the name stands beside the `=>`, and the `async` was left
 * behind as an operand of its own. The statement holding the arrow then did
 * not parse at all, and the block fell back to a raw token walk.
 */
describe("an unparenthesized arrow", () => {
  test.each([
    "async v => v + 1",
    "async v => { return v; }",
    "async v => async w => v + w",
    "v => async w => w",
    "[1].map(async v => v + 1)",
    "async => async",
  ])("reads %s whole", (source) => {
    const { result } = parse(source);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(result.cursor.atEnd).toBe(true);
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
  });

  // `async` modifies the parameters written after it on the same line. With a
  // line break between them it is an ordinary name, and TypeScript reads the
  // arrow after it as one of its own.
  test("is not one when a line break follows `async`", () => {
    const { result } = parse("async\nv => v");
    if (!result.matched) throw new Error("expected an expression");
    expect(result.syntax.form).toBeUndefined();
    expect(printLosslessSequence(result.syntax.children)).toBe("async");
    expect(result.cursor.peek()).toMatchObject({ raw: "v" });
  });

  test.each(["async(1)", "async + 1", "async.then(f)", "async"])(
    "reads %s as the ordinary name it is",
    (source) => {
      const { result } = parse(source);
      if (!result.matched)
        throw new Error(result.failure.expectations.join(", "));
      expect(result.syntax.form).toBeUndefined();
      expect(printLosslessSequence(result.syntax.children)).toBe(source);
    },
  );

  // An arrow is async by its own header, so `await` is an expression in the
  // body of `async v => …` wherever the arrow is written, and in the body of
  // `v => …` nowhere. An arrow is never a generator, so `yield` is an
  // expression in neither.
  test("reads its body in the contexts the arrow's own header gives", () => {
    const outside = { allowYield: false, allowAwait: false };
    const asyncArrow = parse(
      "async v => await load()",
      undefined,
      false,
      outside,
    ).result;
    if (!asyncArrow.matched)
      throw new Error(asyncArrow.failure.expectations.join(", "));
    expect(asyncArrow.syntax.children).toHaveLength(4);
    expect((asyncArrow.syntax.children[3] as ProtectedSyntax).form).toBe(
      "await",
    );
    const inside = { allowYield: true, allowAwait: true };
    // A body this cannot read is kept as the tokens it was written with, so
    // `yield` inside the arrow never becomes the expression it is not.
    const generator = parse(
      "async v => yield 1",
      undefined,
      false,
      inside,
    ).result;
    if (!generator.matched)
      throw new Error(generator.failure.expectations.join(", "));
    expect(generator.syntax.children.map(({ tag }) => tag)).toEqual([
      "token",
      "token",
      "token",
      "token",
      "token",
    ]);
    expect(
      parse("v => await load()", undefined, false, inside).result.matched,
    ).toBe(false);
  });
});

describe("a suspending word", () => {
  /**
   * Where `await` and `yield` are words and where they are operators.
   *
   * Outside the function that admits it, either word is an ordinary name --
   * `const await = 1` is legal TypeScript -- and TypeScript reads it as the
   * operator only where the token beside it, on its line, can be nothing but
   * its operand: an identifier, a keyword, or a number, bigint or string.
   * Every other token is read as what follows the name. So `await + 1` adds,
   * `await * 2` multiplies, `await ? 1 : 2` chooses, `await (v)` calls,
   * `await [v]` indexes, `` await `t` `` tags a template, `await ++x`
   * increments, and `await` written alone is the name itself.
   *
   * `+` begins an operand of its own, which is what made `await + 1` read as
   * an `await` applied to `+1`. That is not a difference an extent comparison
   * catches -- the two readings span the same text -- so what is asserted
   * here is the tree: the word is read exactly as an ordinary name written in
   * its place is, and TypeScript is asked for its own reading of the same
   * text.
   */
  const outsideTheFunction = { allowYield: false, allowAwait: false };

  /** The syntax tree, with each protected node named by its form. */
  function shape(syntax: Syntax): string {
    if (syntax.tag === "token") return syntax.raw;
    const children = syntax.children.map(shape).join(" ");
    if (syntax.tag === "group") return `${syntax.delimiter}(${children})`;
    if (syntax.tag === "protected") return `${syntax.form ?? ""}[${children}]`;
    throw new Error(`unexpected ${syntax.tag} syntax in an expression`);
  }

  /**
   * Whether TypeScript reads the leading `await` or `yield` of `source` as
   * the operator or as a name, asked of the declaration `const x = source;`
   * written inside a plain function.
   */
  function typeScriptReads(source: string): "name" | "operator" {
    const parsed = ts.createSourceFile(
      "fixture.ts",
      `function plain() { const x = ${source}; }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declaration = parsed.statements[0];
    if (
      declaration === undefined ||
      !ts.isFunctionDeclaration(declaration) ||
      declaration.body === undefined
    )
      throw new Error("expected a function declaration");
    const statement = declaration.body.statements[0];
    if (statement === undefined || !ts.isVariableStatement(statement))
      throw new Error("expected a variable statement");
    let node = statement.declarationList.declarations[0]?.initializer;
    // The word heads the initializer, so it is the leftmost leaf of whatever
    // was built over it.
    while (node !== undefined) {
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node))
        return "operator";
      if (ts.isBinaryExpression(node)) node = node.left;
      else if (ts.isConditionalExpression(node)) node = node.condition;
      else if (ts.isPostfixUnaryExpression(node)) node = node.operand;
      else if (ts.isTaggedTemplateExpression(node)) node = node.tag;
      else if (
        ts.isCallExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isNonNullExpression(node)
      )
        node = node.expression;
      else break;
    }
    return "name";
  }

  test.each([
    "await",
    "await + 1",
    "await - 1",
    "await * 2",
    "await ++y",
    "await --y",
    "await ? 1 : 2",
    "await (y)",
    "await [y]",
    "await `t`",
    "await .b",
    "await = 1",
    "await < 1",
    "await && 1",
    "await !",
    "yield",
    "yield + 1",
    "yield - 1",
    "yield * 2",
    "yield ++y",
    "yield --y",
    "yield ? 1 : 2",
    "yield (y)",
    "yield [y]",
    "yield `t`",
    "yield .b",
    "yield = 1",
    "yield < 1",
    "yield && 1",
    "yield !",
  ])("reads %j as the name the word also is, as TypeScript does", (source) => {
    const word = source.startsWith("await") ? "await" : "yield";
    const read = parse(source, undefined, false, outsideTheFunction).result;
    if (!read.matched) throw new Error(read.failure.expectations.join(", "));
    // An ordinary name written in the word's place is the whole expectation:
    // the reading must not depend on which of the three words was written.
    const plain = parse(
      source.replace(word, "name"),
      undefined,
      false,
      outsideTheFunction,
    ).result;
    if (!plain.matched) throw new Error(plain.failure.expectations.join(", "));
    expect(shape(read.syntax).replace(word, "_")).toBe(
      shape(plain.syntax).replace("name", "_"),
    );
    expect(read.cursor.index).toBe(plain.cursor.index);
    expect(typeScriptReads(source)).toBe("name");
  });

  test.each([
    "await v",
    "await 1",
    "await 1n",
    "await 's'",
    "await true",
    "await typeof x",
    "await new X()",
    "await void 0",
    "await instanceof B",
    "yield v",
    "yield 1",
    "yield 1n",
    "yield 's'",
    "yield true",
    "yield typeof x",
    "yield new X()",
    "yield void 0",
    "yield instanceof B",
  ])("refuses %j, where an operand does stand beside the word", (source) => {
    const result = parse(source, undefined, false, outsideTheFunction).result;
    expect(result.matched).toBe(false);
    if (result.matched) throw new Error("expected a refusal");
    expect(result.failure.expectations).toEqual([
      source.startsWith("await")
        ? "await inside an async function"
        : "yield inside a generator",
    ]);
    // TypeScript reads the operator here too, and reports it as one written
    // where it is not allowed rather than as a name.
    expect(typeScriptReads(source)).toBe("operator");
  });

  test.each([
    ["await + 1", "await", { allowYield: false, allowAwait: true }],
    ["await - 1", "await", { allowYield: false, allowAwait: true }],
    ["await ++y", "await", { allowYield: false, allowAwait: true }],
    ["await (y)", "await", { allowYield: false, allowAwait: true }],
    ["await [y]", "await", { allowYield: false, allowAwait: true }],
    ["await `t`", "await", { allowYield: false, allowAwait: true }],
    ["yield + 1", "yield", { allowYield: true, allowAwait: false }],
    ["yield - 1", "yield", { allowYield: true, allowAwait: false }],
    ["yield * 2", "yield", { allowYield: true, allowAwait: false }],
    ["yield ++y", "yield", { allowYield: true, allowAwait: false }],
    ["yield (y)", "yield", { allowYield: true, allowAwait: false }],
    ["yield [y]", "yield", { allowYield: true, allowAwait: false }],
  ])(
    "reads %j as the %s operator inside the function that admits it",
    (source, form, contexts) => {
      const result = parse(source, undefined, false, contexts).result;
      if (!result.matched)
        throw new Error(result.failure.expectations.join(", "));
      expect(result.syntax.form).toBe(form);
      expect(printLosslessSequence(result.syntax.children)).toBe(source);
      expect(result.cursor.atEnd).toBe(true);
    },
  );

  test("reads `await + 1` as a sum outside async and as an await inside it", () => {
    const outside = parse(
      "await + 1",
      undefined,
      false,
      outsideTheFunction,
    ).result;
    if (!outside.matched)
      throw new Error(outside.failure.expectations.join(", "));
    expect(outside.syntax.form).toBeUndefined();
    expect(shape(outside.syntax)).toBe("[[await] + [1]]");
    const inside = parse("await + 1", undefined, false, {
      allowYield: false,
      allowAwait: true,
    }).result;
    if (!inside.matched)
      throw new Error(inside.failure.expectations.join(", "));
    expect(inside.syntax.form).toBe("await");
    expect(shape(inside.syntax)).toBe("await[await [+ [1]]]");
  });
});
