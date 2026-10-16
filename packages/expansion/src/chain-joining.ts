import type { SyntaxId } from "@sweetener/shared";
import {
  angleWidth,
  coreExpressionOperators,
  coreTypeOperators,
  createGroup,
  createProtectedSyntax,
  createSyntaxSequence,
  spanEnvelope,
  type CoreOperator,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
} from "@sweetener/syntax";

/**
 * Where a step that holds the syntax built before it continues the chain of
 * operators that syntax is: what of the step stands before it and after it,
 * once every node between the two is opened.
 */
export interface ChainLink {
  readonly before: readonly Syntax[];
  readonly after: readonly Syntax[];
}

/** What a joined chain's nodes are made with. */
export interface ChainNodes {
  readonly allocateSyntaxId: () => SyntaxId;
  readonly origins: OriginStore;
}

/**
 * The precedence of `node` when it is a chain of one left-associative core
 * operator's level -- `a + b`, or `a + b - c` held as one node -- whose
 * operands are all expressions.
 */
function chainPrecedence(node: Syntax): number | undefined {
  if (
    node.tag !== "protected" ||
    node.category !== "expr" ||
    node.form !== undefined ||
    node.precedence === undefined ||
    node.children.length < 3 ||
    node.children[0]!.tag !== "protected"
  )
    return undefined;
  let spelling = "";
  for (const child of node.children.slice(1)) {
    if (child.tag === "token") {
      spelling += child.raw;
      continue;
    }
    const operator = coreExpressionOperators.find(
      (candidate) =>
        candidate.fixity === "infix" && candidate.spelling === spelling,
    );
    if (
      child.tag !== "protected" ||
      child.category !== "expr" ||
      operator?.associativity !== "left" ||
      operator.precedence !== node.precedence
    )
      return undefined;
    spelling = "";
  }
  return spelling === "" ? node.precedence : undefined;
}

/**
 * The operator a type is a union or an intersection of at its top level,
 * where nothing there binds looser: `|` for `A | B[]`, nothing for a
 * function type or a conditional one. Angle brackets are tokens, so what
 * stands between them is skipped.
 */
function typeChainOperator(node: Syntax): "|" | "&" | undefined {
  if (node.tag !== "protected" || node.category !== "type") return undefined;
  let loosest: CoreOperator | undefined;
  let angles = 0;
  for (const child of node.children) {
    if (child.tag !== "token") continue;
    const depth = angles;
    angles = Math.max(
      0,
      angles + angleWidth(child.raw, "<") - angleWidth(child.raw, ">"),
    );
    if (depth > 0 || angles > 0) continue;
    const operator = coreTypeOperators.find(
      (candidate) =>
        candidate.fixity === "infix" && candidate.spelling === child.raw,
    );
    if (
      operator !== undefined &&
      (loosest === undefined || operator.precedence < loosest.precedence)
    )
      loosest = operator;
  }
  return loosest?.spelling === "|" || loosest?.spelling === "&"
    ? loosest.spelling
    : undefined;
}

/**
 * Where `accumulator` joins the chain of operators `built` is, when it
 * continues it: what of `built` stands before it and after it, once every
 * node between the two is opened. An expression joins when it is the head
 * of a left-associative chain of its own level -- `$acc + $item` -- and a
 * type when it is a member of a union, or of an intersection, it is one of
 * too -- `$acc | $item`, `$item | $acc`. Read on, the two say the same.
 */
export function chainLink(
  built: ProtectedSyntax,
  accumulator: ProtectedSyntax,
): ChainLink | undefined {
  if (built.category === "type") {
    const operator = typeChainOperator(built);
    if (operator === undefined || typeChainOperator(accumulator) !== operator)
      return undefined;
    const at = built.children.indexOf(accumulator);
    const parts = (node: Syntax | undefined) =>
      node === undefined || (node.tag === "token" && node.raw === operator);
    return at >= 0 &&
      parts(built.children[at - 1]) &&
      parts(built.children[at + 1])
      ? {
          before: built.children.slice(0, at),
          after: built.children.slice(at + 1),
        }
      : undefined;
  }
  const precedence = chainPrecedence(built);
  if (precedence === undefined || chainPrecedence(accumulator) !== precedence)
    return undefined;
  const after: (readonly Syntax[])[] = [];
  let current: Syntax = built;
  while (current !== accumulator) {
    if (current.tag !== "protected" || chainPrecedence(current) !== precedence)
      return undefined;
    after.push(current.children.slice(1));
    current = current.children[0]!;
  }
  return { before: [], after: after.reverse().flat() };
}

/** `node` with `target` replaced by `replacement` wherever it stands in it. */
function replacing(
  node: Syntax,
  target: Syntax,
  replacement: Syntax,
  nodes: ChainNodes,
): Syntax {
  if (node === target) return replacement;
  if (node.tag !== "group" && node.tag !== "protected") return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = replacing(child, target, replacement, nodes);
    changed ||= next !== child;
    return next;
  });
  if (!changed) return node;
  return node.tag === "group"
    ? createGroup({
        ...node,
        id: nodes.allocateSyntaxId(),
        children: createSyntaxSequence(children),
      })
    : createProtectedSyntax({
        ...node,
        id: nodes.allocateSyntaxId(),
        children,
      });
}

/**
 * The expression or type that `accumulators` built, each holding the one
 * before it, with each that continued the chain of the one after it -- as
 * `links` says -- opened into that chain: `0 + a + b` is one node rather than
 * one per step, as deep as the operators the steps write and no deeper. The
 * chain is gathered once, in the order the steps built it, so a chain of any
 * length costs what it built. A fold's accumulators are built this way, and
 * so are the expansions of a chain of operators.
 */
export function joinedChain(
  accumulators: readonly ProtectedSyntax[],
  links: readonly (ChainLink | undefined)[],
  nodes: ChainNodes,
): ProtectedSyntax {
  let joined: ProtectedSyntax = accumulators[0]!;
  let open:
    | {
        top: ProtectedSyntax;
        readonly base: readonly Syntax[];
        readonly befores: (readonly Syntax[])[];
        readonly afters: (readonly Syntax[])[];
      }
    | undefined;
  const close = () => {
    if (open === undefined) return;
    const children: Syntax[] = [];
    for (let at = open.befores.length - 1; at >= 0; at -= 1)
      children.push(...open.befores[at]!);
    children.push(...open.base);
    for (const after of open.afters) children.push(...after);
    const origins = [...new Set(children.map(({ origin }) => origin))];
    joined = createProtectedSyntax({
      ...open.top,
      id: nodes.allocateSyntaxId(),
      span: spanEnvelope(children.map(({ span }) => span)),
      origin:
        origins.length === 1 ? origins[0]! : nodes.origins.composed(origins),
      children,
    });
    open = undefined;
  };
  for (let at = 1; at < accumulators.length; at += 1) {
    const built = accumulators[at]!;
    const link = links[at];
    if (link === undefined) {
      close();
      const previous = accumulators[at - 1]!;
      joined =
        joined === previous
          ? built
          : (replacing(built, previous, joined, nodes) as ProtectedSyntax);
      continue;
    }
    if (open === undefined) {
      // A union opened into another needs no `|` of its own in front.
      const [head, ...rest] = joined.children;
      open = {
        top: built,
        base:
          joined.category === "type" &&
          head?.tag === "token" &&
          typeChainOperator(joined) === head.raw
            ? rest
            : joined.children,
        befores: [],
        afters: [],
      };
    }
    open.top = built;
    open.befores.push(link.before);
    open.afters.push(link.after);
  }
  close();
  return joined;
}
