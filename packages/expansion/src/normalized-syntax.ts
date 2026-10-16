import type { OriginId, SyntaxId } from "@sweetener/shared";
import {
  createGroup,
  createProtectedSyntax,
  type GroupSyntax,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
  type SyntaxSequence,
} from "@sweetener/syntax";

declare const normalizedSyntaxBrand: unique symbol;

/**
 * A reading `normalizeProtectedInput` has normalized, and nothing else.
 *
 * Each route the expander asks to read syntax for it -- `enforest` and the
 * `enforest...` options of `ExpandMacroSyntaxOptions` -- answers with this,
 * so a route that skips normalization does not compile. A route that skipped
 * it handed the walk a shape the normalized routes never produce, and the walk
 * read the two differently: while the infix `=>` protected an arrow's
 * parameter list as an expression, a route that left it that way had a
 * parameter spelled like a macro dispatched.
 */
export type NormalizedSyntax = ProtectedSyntax & {
  readonly [normalizedSyntaxBrand]: "NormalizedSyntax";
};

export interface NormalizationOptions {
  readonly origins: OriginStore;
  readonly allocateSyntaxId: () => SyntaxId;
}

/**
 * What `writtenInSource` has answered, per store. An origin never changes
 * once stored, so neither does the answer. A chain of operators composes the
 * origin of each node from the origin of the one before it, and asking afresh
 * at every node walked the chain below it again: two thousand names took about
 * four times as long to expand as they did without asking.
 */
const writtenInSourceAnswers = new WeakMap<
  OriginStore,
  Map<OriginId, boolean>
>();

/** Whether syntax came from source text alone, with no expansion in it. */
function writtenInSource(origins: OriginStore, origin: OriginId): boolean {
  let answers = writtenInSourceAnswers.get(origins);
  if (answers === undefined) {
    answers = new Map();
    writtenInSourceAnswers.set(origins, answers);
  }
  const known = answers.get(origin);
  if (known !== undefined) return known;
  const record = origins.get(origin);
  const answer =
    record !== undefined &&
    (record.kind === "source" ||
      (record.kind === "composed" &&
        record.parts.every((part) => writtenInSource(origins, part))));
  answers.set(origin, answer);
  return answer;
}

/**
 * The protected nodes a run hands the reader: those standing in it, and
 * those in its groups. A reader that meets one takes it as it stands, so
 * a reading holds these nodes themselves rather than copies of them.
 */
export function handedIn(syntax: SyntaxSequence): ReadonlySet<Syntax> {
  const handed = new Set<Syntax>();
  const collect = (nodes: SyntaxSequence): void => {
    for (const node of nodes) {
      if (node.tag === "protected") handed.add(node);
      else if (node.tag === "group") collect(node.children);
    }
  };
  collect(syntax);
  return handed;
}

/**
 * `node` with the nesting the reader built while reading it removed, where
 * that nesting is redundant with the text it was read from.
 *
 * What the reader was handed is kept as it stands, `handed` saying which
 * nodes those are. A protected node in the run was not built by this
 * reading, and the reader takes it whole rather than reading it again; an
 * expansion may have built it to say something the text does not. A
 * replacement of several items arrives as one item holding them, and
 * `#core` in item position wraps the item it read in one more. Flattening
 * the first ran two declarations together as one. Flattening the second
 * spliced the bare declaration into the template around the call, where the
 * item reader met a function whose body was read already and could not
 * read it again, and a `function` the wrapping had kept from being read
 * again was handed to the macro shadowing it.
 */
export function normalizeProtectedInput(
  node: ProtectedSyntax,
  handed: ReadonlySet<Syntax>,
  options: NormalizationOptions,
): NormalizedSyntax {
  if (handed.has(node)) return node as NormalizedSyntax;
  // Walked with a stack of its own rather than by recursion. A chain of
  // operators is read as one node per operator, each holding the one before
  // it, and recursing through them exhausted the call stack: `v0 + v1 + …`
  // two thousand names long was enough, written in source or in a template.
  const pending: Pending[] = [opened(node)];
  let finished: ProtectedSyntax | GroupSyntax | undefined;
  for (;;) {
    const top = pending.at(-1)!;
    const children = top.node.children;
    if (finished !== undefined) {
      const child = children[top.at]!;
      keep(
        top,
        child,
        replacement(child, finished, top.category, children.length, options),
      );
      top.at += 1;
      finished = undefined;
    }
    let next: ProtectedSyntax | GroupSyntax | undefined;
    while (next === undefined && top.at < children.length) {
      const child = children[top.at]!;
      if (
        (child.tag === "protected" && !handed.has(child)) ||
        child.tag === "group"
      ) {
        next = child;
      } else {
        top.normalized?.push(child);
        top.at += 1;
      }
    }
    if (next !== undefined) {
      pending.push(opened(next));
      continue;
    }
    pending.pop();
    const closed = rebuilt(top, options);
    if (pending.length === 0) return closed as NormalizedSyntax;
    finished = closed;
  }
}

/**
 * `node` branded as it stands, for a reader that builds no protected node
 * inside one of its own category. Throws where normalizing would change it.
 *
 * A JSX child wraps the one node it was handed, and a type member reads its
 * type as tokens, any object type in it a list of members inside a brace. So
 * their routes have nothing to normalize, and they answer with this rather
 * than with a normalization nothing could exercise. A reader that comes to
 * build such nesting fails its first reading here instead of handing the walk
 * a shape the other routes never produce.
 */
export function alreadyNormal(
  node: ProtectedSyntax,
  handed: ReadonlySet<Syntax>,
  options: NormalizationOptions,
): NormalizedSyntax {
  if (normalizeProtectedInput(node, handed, options) !== node)
    throw new Error(
      `A ${node.category} reading holds a protected node of its own category that the reader built, so its route has to normalize what it reads`,
    );
  return node as NormalizedSyntax;
}

/** A node whose children are being normalized, and how far that has got. */
interface Pending {
  readonly node: ProtectedSyntax | GroupSyntax;
  /**
   * The category its children are read in. Undefined inside a group: nesting
   * is only redundant when the protected node sits directly in a protected
   * node of its own category. A group delimits, so what it holds is a list of
   * its own -- an interface body is protected as a `typeMember` run and holds
   * one protected member per member, and carrying the category through the
   * brace flattened every member back into loose tokens.
   */
  readonly category: SyntaxCategory | undefined;
  at: number;
  /**
   * Its children so far, from the first one that changed. Until one does the
   * node is kept rather than rebuilt, which is what almost every prepared
   * statement finds: rebuilding it anyway allocated a fresh id for every
   * protected node and every group beneath it, so the id space filled with
   * new nodes standing for syntax that had not moved.
   */
  normalized: Syntax[] | undefined;
}

function opened(node: ProtectedSyntax | GroupSyntax): Pending {
  return {
    node,
    category: node.tag === "protected" ? node.category : undefined,
    at: 0,
    normalized: undefined,
  };
}

function keep(
  into: Pending,
  child: Syntax,
  replacement: readonly Syntax[] | undefined,
): void {
  if (replacement === undefined) {
    into.normalized?.push(child);
    return;
  }
  into.normalized ??= into.node.children.slice(0, into.at);
  // One at a time: a chain of operators is one node holding every operand and
  // operator in it, and spread into `push` a hundred thousand of them are
  // more arguments than a call can take.
  for (const node of replacement) into.normalized.push(node);
}

function rebuilt(
  pending: Pending,
  options: NormalizationOptions,
): ProtectedSyntax | GroupSyntax {
  const { node, normalized } = pending;
  if (normalized === undefined) return node;
  return node.tag === "protected"
    ? createProtectedSyntax({
        ...node,
        id: options.allocateSyntaxId(),
        children: normalized,
      })
    : createGroup({
        ...node,
        id: options.allocateSyntaxId(),
        children: normalized,
      });
}

/**
 * What `child` stands for in its parent once it has normalized to
 * `normalized`, or undefined where it stands for itself. Saying so rather
 * than returning a one-element run of it lets a node whose whole subtree is
 * already normal be kept rather than rebuilt.
 */
function replacement(
  child: Syntax,
  normalized: ProtectedSyntax | GroupSyntax,
  category: SyntaxCategory | undefined,
  siblings: number,
  options: NormalizationOptions,
): readonly Syntax[] | undefined {
  if (normalized.tag === "protected") {
    // An expression or type nested in another is not redundant where an
    // expansion produced it. Such syntax is printed from its structure
    // rather than copied from text, so the nesting is the boundary its
    // operators bind within, and nothing else says so. An operator's
    // expansion arrives here holding its operands that way, and
    // flattening them printed `$value * $n` over `1 + 2` and `3 + 4` as
    // `1 + 2 * 3 + 4`; a template's `<$asserted>-$value * 2` lost the
    // assertion the printer respells as `as`, and was printed as written.
    // What the parser built over source text is redundant with that text.
    // Keeping it is right only where the reader builds nothing as an
    // expression that is not one: the infix `=>` once protected an arrow's
    // parameters as an expression, this kept the wrapping in a template,
    // and the parameters were walked as the expression it said they were.
    const bounds =
      (category === "expr" || category === "type") &&
      !writtenInSource(options.origins, normalized.origin);
    // A statement standing beside other syntax inside a statement is
    // a substatement, not a redundant wrapping: `here: log(x);` and
    // `while (c) log(x);` each read one statement inside another, and
    // the syntax beside it is the label or the header that reads it.
    // Flattened, the head of that statement stood right after the
    // `:` or the header, where a type is written -- so a statement
    // macro written there was refused for being declared `stmt`.
    const substatement =
      category === "stmt" && normalized.category === "stmt" && siblings > 1;
    if (normalized.category === category && !bounds && !substatement)
      return normalized.children;
  }
  return normalized === child ? undefined : [normalized];
}
