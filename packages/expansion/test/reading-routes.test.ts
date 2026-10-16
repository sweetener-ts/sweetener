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
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  OriginStore,
  spanEnvelope,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  alreadyNormal,
  compileParsedMacros,
  createExpansionFrontendSession,
  ExpansionGuard,
  handedIn,
} from "../src/index.js";

/**
 * Each route the expander reads syntax through, asked directly.
 *
 * A route answers with `NormalizedSyntax`: what its reader built inside a
 * protected node of the same category is taken apart, and what it was handed
 * is kept as it stands. The statement, item and class element readers, the
 * expression route and the single-node route all build an expression inside
 * an expression -- an operator's operands -- so each is shown normalizing one.
 * The type member and JSX child readers build no such nesting at all; their
 * routes check that they did not, rather than normalizing.
 */

const definitionSource = 993 as SourceId;
const readSource = 994 as SourceId;

function harness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("module", "reading-route-definitions"),
  );
  const definitions = readSyntax("", {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
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
    spanForOrigin: () => ({ start: 0, end: 0 }),
  });
  const tracker = new ResourceTracker(createResourceBudget());
  const session = createExpansionFrontendSession({
    module,
    sourceId: readSource,
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
  const useScopes = scopes.singleton(scopes.freshScope("lexical", "use"));
  const read = (source: string) =>
    createSyntaxSequence(
      readSyntax(source, {
        sourceId: readSource,
        scopes: useScopes,
        originStore: origins,
      }).root.children.filter(
        (node) => node.tag !== "token" || node.kind !== "end-of-file",
      ),
    );
  const protect = (
    category: SyntaxCategory,
    children: readonly Syntax[],
  ): ProtectedSyntax =>
    createProtectedSyntax({
      id: syntaxIds.allocate(),
      span: spanEnvelope(children.map(({ span }) => span)),
      origin: children[0]!.origin,
      scopes: children[0]!.scopes,
      category,
      children,
    });
  /**
   * `a + b` protected the way the reader protects it, an operand in a node of
   * its own: what a route is handed when an expansion built it.
   */
  const handedSum = (): ProtectedSyntax => {
    const [a, plus, b] = read("a + b");
    return protect("expr", [protect("expr", [a!]), plus!, b!]);
  };
  return {
    routes: session.routes,
    consumeClass: session.consumeClass,
    module,
    read,
    protect,
    handedSum,
    normalization: { origins, allocateSyntaxId: syntaxIds.allocate },
  };
}

const contexts = new Set<never>();

/** Whether a protected node stands directly in one of its own category. */
function nested(node: Syntax): boolean {
  if (node.tag === "token" || node.tag === "root") return false;
  return node.children.some(
    (child) =>
      (node.tag === "protected" &&
        child.tag === "protected" &&
        child.category === node.category) ||
      nested(child),
  );
}

/** Whether `wanted` itself stands somewhere in `nodes`. */
function holds(nodes: readonly Syntax[], wanted: Syntax): boolean {
  return nodes.some(
    (node) =>
      node === wanted ||
      ((node.tag === "group" || node.tag === "protected") &&
        holds(node.children, wanted)),
  );
}

const print = (nodes: readonly Syntax[]) =>
  printLosslessSequence(nodes).replace(/\s+/gu, " ").trim();

describe("a route whose reader nests an expression in an expression", () => {
  const cases: readonly {
    readonly route: string;
    readonly source: string;
    /** Source with `$` where the handed node stands. */
    readonly around: readonly [string, string];
    readonly reading: (
      setup: ReturnType<typeof harness>,
      syntax: readonly Syntax[],
    ) => readonly Syntax[] | undefined;
  }[] = [
    {
      route: "the statement list route",
      source: "x = a + b;",
      around: ["x = ", ";"],
      reading: ({ routes }, syntax) =>
        routes.enforestStatements({
          syntax: createSyntaxSequence(syntax),
          contexts,
        }),
    },
    {
      route: "the item list route",
      source: "const x = a + b;",
      around: ["const x = ", ";"],
      reading: ({ routes }, syntax) =>
        routes.enforestItems({
          syntax: createSyntaxSequence(syntax),
          contexts,
        }),
    },
    {
      route: "the class element route",
      source: "m() { return a + b; }",
      around: ["m() { return ", "; }"],
      reading: ({ routes }, syntax) =>
        routes.enforestClassElements({
          syntax: createSyntaxSequence(syntax),
          contexts,
        }),
    },
    {
      route: "the expression route",
      source: "a + b",
      around: ["", ""],
      reading: ({ routes }, syntax) => {
        const read = routes.enforestExpression({
          syntax: createSyntaxSequence(syntax),
          contexts,
        });
        return read === undefined ? undefined : [read];
      },
    },
    {
      route: "the single-node route",
      source: "a + b",
      around: ["", ""],
      reading: ({ routes, module }, syntax) => [
        routes.enforest({
          syntax: createSyntaxSequence(syntax),
          category: "expr",
          lexicalModule: module,
          contexts,
        }),
      ],
    },
  ];

  for (const { route, source, around, reading } of cases) {
    test(`${route} takes apart the nesting its reader built`, () => {
      const setup = harness();
      const read = reading(setup, setup.read(source));
      expect(read).toBeDefined();
      expect(print(read!)).toBe(source);
      expect(read!.some(nested)).toBe(false);
    });

    test(`${route} keeps a node it was handed as it stands`, () => {
      const setup = harness();
      const handed = setup.handedSum();
      const syntax = [
        ...setup.read(around[0]),
        handed,
        ...setup.read(around[1]),
      ].filter((node) => node.tag !== "token" || node.raw !== "");
      const read = reading(setup, syntax);
      expect(read).toBeDefined();
      expect(holds(read!, handed)).toBe(true);
      expect(nested(handed)).toBe(true);
    });
  }
});

describe("a route whose reader builds no nesting", () => {
  test("the type member route hands over what it read as it stands", () => {
    const setup = harness();
    const handed = setup.protect("type", [setup.handedSum()]);
    const read = setup.routes.enforestTypeMembers({
      syntax: createSyntaxSequence([
        ...setup.read("a: { b: number; c: string };\nd: "),
        handed,
        ...setup.read(";"),
      ]),
      contexts,
    });
    expect(read).toBeDefined();
    expect(read!.map((member) => print([member]))).toEqual([
      "a: { b: number; c: string };",
      // The handed node carries no space of its own in front of it.
      "d:a + b;",
    ]);
    expect(holds(read!, handed)).toBe(true);
  });

  test("the JSX child route hands over what it read as it stands", () => {
    const setup = harness();
    const [container] = setup.read("{a + b}");
    const handed = setup.protect("jsxChild", [
      setup.protect("jsxChild", [container!]),
    ]);
    const read = setup.routes.enforestJsxChildren({
      syntax: createSyntaxSequence([handed, ...setup.read("{c}")]),
      contexts,
    });
    expect(read).toBeDefined();
    expect(read).toHaveLength(2);
    expect(read![0]!.children[0]).toBe(handed);
  });

  test("a reading that holds nesting its reader built is refused", () => {
    const setup = harness();
    const built = setup.handedSum();
    expect(() =>
      alreadyNormal(built, handedIn([]), setup.normalization),
    ).toThrow(/has to normalize what it reads/u);
    expect(alreadyNormal(built, handedIn([built]), setup.normalization)).toBe(
      built,
    );
  });
});

describe("a macro pattern's capture", () => {
  test.each(["expr", "type"] as const)(
    "of an %s takes apart the nesting its reader built",
    (category) => {
      const setup = harness();
      const classId = setup.module.classId(category);
      if (classId === undefined) throw new Error(`no ${category} class`);
      const source = category === "expr" ? "a + b * c" : "A | B[]";
      const match = setup.consumeClass(
        classId,
        createSyntaxCursor(setup.read(source)),
      );
      expect(match).toBeDefined();
      expect(print(match!.syntax)).toBe(source);
      expect(match!.syntax.some(nested)).toBe(false);
    },
  );
});
