import type { OriginId, SyntaxId } from "@sweetener/shared";
import type {
  MissingToken,
  Origin,
  OriginStore,
  ProtectedSyntax,
  Syntax,
  TokenSyntax,
} from "@sweetener/syntax";
import type { NameAssignmentPlan } from "./name-assignment.js";

export type GeneratedRegionKind = Origin["kind"] | "grouping";

export interface OriginMapEntry {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly origin: OriginId;
  readonly kind: GeneratedRegionKind;
}

export interface OriginMap {
  readonly schemaVersion: 1;
  readonly entries: readonly OriginMapEntry[];
}

export const expansionTraceSchemaVersion = 1 as const;

export interface ExpansionTraceEnvelope<Trace> {
  readonly schemaVersion: typeof expansionTraceSchemaVersion;
  readonly events: Trace;
}

export function createExpansionTraceEnvelope<Trace>(
  events: Trace,
): ExpansionTraceEnvelope<Trace> {
  return Object.freeze({ schemaVersion: expansionTraceSchemaVersion, events });
}

/**
 * Where one token's own text landed in the printed output, excluding trivia.
 * Hygienic renaming parses the printed text with TypeScript and needs to map
 * the offsets it reports back to the syntax tokens that produced them.
 */
export interface PrintedTokenSpan {
  readonly syntax: SyntaxId;
  readonly start: number;
  readonly end: number;
}

export interface PrintedExpandedFile<Trace = unknown> {
  readonly text: string;
  readonly originMap: OriginMap;
  readonly tokenSpans: readonly PrintedTokenSpan[];
  readonly trace: Trace;
  readonly serializedTrace: string;
}

export interface PrintExpandedFileOptions<Trace> {
  readonly syntax: readonly Syntax[];
  readonly origins: OriginStore;
  readonly trace: Trace;
  readonly names?: NameAssignmentPlan | undefined;
  readonly groupProtectedExpression?:
    | ((syntax: Extract<Syntax, { readonly tag: "protected" }>) => boolean)
    | undefined;
}

type PrintItem =
  | Syntax
  | MissingToken
  | {
      readonly text: string;
      readonly origin: OriginId;
      readonly grouping: true;
    };

function canonical(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Expansion traces require finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) throw new TypeError("Expansion trace is cyclic");
    active.add(value);
    const result = value.map((item) => canonical(item, active));
    active.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (active.has(value)) throw new TypeError("Expansion trace is cyclic");
    active.add(value);
    const result = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item, active)]),
    );
    active.delete(value);
    return result;
  }
  throw new TypeError(`Expansion trace contains unsupported ${typeof value}`);
}

export function serializeExpansionTrace(trace: unknown): string {
  return `${JSON.stringify(canonical(trace), null, 2)}\n`;
}

/** Characters that continue an identifier, keyword, or numeric literal. */
function wordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{ID_Continue}$]/u.test(value);
}

/** Tokens that bind against neighbours, and so need the grouping kept. */
/** What ends an arrow's body where it stands in a sequence of nodes. */
const arrowBodyEnds: ReadonlySet<string> = new Set([";", ",", ":"]);

const nonBinding = new Set([".", "?.", "!", ",", ";", ":", "=>", "...", "?"]);

function bindingOperator(token: TokenSyntax): boolean {
  if (token.kind === "keyword")
    return [
      "as",
      "satisfies",
      "in",
      "instanceof",
      "typeof",
      "void",
      "delete",
      "await",
      "yield",
      "new",
    ].includes(token.raw);
  if (token.kind !== "punctuation") return false;
  return !nonBinding.has(token.raw);
}

/**
 * The same question asked of a type, where the answer is a different one.
 *
 * A type has its own operators and its own precedence: `|` and `&` bind looser
 * than the postfix `[]` and than indexed access, so a macro that expands to
 * `string | null` is re-associated by whatever follows it -- `orNull(string)[]`
 * printed as `string | null[]`, which is an array of `null` unioned with
 * `string`. Where the expression rule reads every punctuation mark as binding
 * unless excused, this one names what binds: a type holds far more punctuation
 * that groups on its own -- `.` in a qualified name, `<>` around arguments,
 * `[]` for an array or an index -- than punctuation that re-associates.
 *
 * `extends` covers conditional types, whose `?` and `:` cannot stand without
 * it; listing those directly would parenthesize every optional property and
 * every annotation instead.
 */
const typePunctuationOperators = new Set(["|", "&", "=>"]);
const typeKeywordOperators = new Set([
  "keyof",
  "typeof",
  "infer",
  "readonly",
  "extends",
  "is",
  "asserts",
  "in",
]);

function typeBindingOperator(token: TokenSyntax): boolean {
  if (token.kind === "keyword") return typeKeywordOperators.has(token.raw);
  return (
    token.kind === "punctuation" && typePunctuationOperators.has(token.raw)
  );
}

export function printExpandedFile<Trace>(
  options: PrintExpandedFileOptions<Trace>,
): PrintedExpandedFile<Trace> {
  const replacements = new Map(
    (options.names?.rewrites ?? []).map(({ syntax, replacement }) => [
      syntax,
      replacement,
    ]),
  );
  if (replacements.size !== (options.names?.rewrites.length ?? 0))
    throw new RangeError("Printed file contains duplicate name rewrites");
  const chunks: string[] = [];
  const entries: OriginMapEntry[] = [];
  const tokenSpans: PrintedTokenSpan[] = [];
  let offset = 0;
  let lastCharacter: string | undefined;
  /**
   * The nodes that are the whole body of an arrow. An arrow's body is parsed
   * as an expression, so it arrives here as one protected node; wrapping that
   * in parentheses printed `(value: number) => (value + 1)`, which is the same
   * function spelled worse. Nothing to either side of a body can re-associate
   * into it -- it runs to the end of the arrow -- so nothing has to hold it
   * together.
   *
   * Only a node that ends where the body does. Exempting whatever was printed
   * first after `=>` also exempted the callee of a call that was the body:
   * `(x) => $f(x)` with `$f` an arrow printed `(x) => (n) => n * 2(x)`.
   */
  const wholeArrowBodies = new Set<Syntax>();
  /**
   * Operands that already bind tighter than the operator the parser read them
   * under, so they hold together without parentheses: `value * 2` in
   * `value * 2 + 1`.
   */
  const boundOperands = new Set<Syntax>();
  const markBoundOperands = (parent: ProtectedSyntax) => {
    const precedence = parent.precedence;
    if (parent.category !== "expr" || precedence === undefined) return;
    const children = parent.children;
    const operand = (node: Syntax | undefined) =>
      node?.tag === "protected" &&
      node.category === "expr" &&
      node.precedence !== undefined
        ? node
        : undefined;
    const bind = (node: Syntax | undefined, minimum: number) => {
      const found = operand(node);
      if (found !== undefined && found.precedence! >= minimum)
        boundOperands.add(found);
    };
    if (parent.form === "conditional") {
      // `test ? consequent : alternate`: the test is a short-circuit
      // expression, and the alternate an assignment-level one.
      bind(children[0], 40);
      bind(children[2], 11);
      bind(children[4], 20);
      return;
    }
    const first = children[0];
    const last = children.at(-1);
    const operator = children
      .slice(1, -1)
      .map((child) => (child.tag === "token" ? child.raw : undefined));
    const operandAt = (node: Syntax | undefined) =>
      node !== undefined &&
      (node.tag !== "token" || node.kind !== "punctuation");
    if (
      children.length >= 3 &&
      operandAt(first) &&
      operandAt(last) &&
      operator.every((raw) => raw !== undefined)
    ) {
      const spelling = operator.join("");
      const rightAssociative =
        spelling === "**" || parent.form === "assignment";
      const left = operand(first);
      const right = operand(last);
      const logical = (node: ProtectedSyntax | undefined) =>
        node?.precedence === 50 || node?.precedence === 60;
      // `??` cannot sit beside `||` or `&&` unparenthesized, and a unary
      // operand of `**` must keep its parentheses.
      const unaryBase = spelling === "**" && left?.children[0]?.tag === "token";
      if (!(spelling === "??" && logical(left)) && !unaryBase)
        bind(first, rightAssociative ? precedence + 1 : precedence);
      if (!(spelling === "??" && logical(right)))
        bind(last, rightAssociative ? precedence : precedence + 1);
      return;
    }
    // A prefix operator other than `new`, whose operand's parentheses decide
    // what is constructed.
    if (first?.tag === "token" && first.raw !== "new" && children.length === 2)
      bind(last, precedence + 1);
  };
  const emit = (text: string, origin: OriginId, kind: GeneratedRegionKind) => {
    if (text.length === 0) return;
    const start = offset;
    chunks.push(text);
    offset += text.length;
    lastCharacter = text[text.length - 1];
    entries.push(
      Object.freeze({
        generatedStart: start,
        generatedEnd: offset,
        origin,
        kind,
      }),
    );
  };
  const kindFor = (origin: OriginId): Origin["kind"] => {
    const value = options.origins.get(origin);
    if (value === undefined)
      throw new RangeError(`Cannot print unknown origin ${String(origin)}`);
    return value.kind;
  };
  const pending: PrintItem[] = [...options.syntax].reverse();
  const pushChildren = (children: readonly Syntax[], list = false) => {
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      const previous = children[index - 1];
      const next = children[index + 1];
      if (
        previous?.tag === "token" &&
        previous.raw === "=>" &&
        (next === undefined ||
          (next.tag === "token" && arrowBodyEnds.has(next.raw)))
      )
        wholeArrowBodies.add(child);
      // An argument or an array element is a whole assignment expression, so
      // an arrow, a conditional or an operator expression written as one
      // needs no parentheses of its own: `map(values, (n) => n * 10)`. Only a
      // comma expression, or an expression whose precedence is unknown,
      // could run into the next element.
      const comma = (node: Syntax | undefined) =>
        node?.tag === "token" && node.raw === ",";
      if (
        child.tag === "protected" &&
        child.category === "expr" &&
        (child.form !== undefined || (child.precedence ?? 0) > 10) &&
        (previous === undefined ? list : comma(previous)) &&
        (next === undefined ? list : comma(next))
      )
        boundOperands.add(child);
      pending.push(child);
    }
  };
  // A grouping parenthesis stands outside the layout that separates the
  // expansion from whatever precedes it. Emitted the moment it was reached, it
  // landed before the first token's leading trivia and printed
  // `const value: number =( 1 + 2) * 10` — the space belongs before the
  // parenthesis, not after it. Holding it until a token is actually printed
  // puts it where it reads.
  const pendingOpens: { readonly text: string; readonly origin: OriginId }[] =
    [];
  const flushOpens = () => {
    for (const open of pendingOpens) emit(open.text, open.origin, "grouping");
    pendingOpens.length = 0;
  };
  const pushToken = (token: TokenSyntax) => {
    const kind = kindFor(token.origin);
    const leading = token.leadingTrivia.map(({ raw }) => raw).join("");
    const text = replacements.get(token.id) ?? token.raw;
    // Trivia gets a region of its own so the token's region is exactly the
    // token. A region carries the token's whole source span, and a position
    // inside it is projected by its offset from the region start, so folding
    // the surrounding layout in would shift every offset within the token.
    // The region's kind marks it as layout, and a synthesized region projects
    // to the start of its source span, so the token's own origin serves —
    // minting one per token cost an origin and an intern entry for every
    // piece of trivia in the file.
    emit(leading, token.origin, "synthesized");
    flushOpens();
    // A template writes the space in `typeof $value` as trivia on its own
    // `$value`, which substitution replaces along with the token. Without a
    // separator the two words print as one, so one is added back when the
    // characters either side would otherwise lex together. Trivia and an
    // opening parenthesis both already separate them, so this asks what was
    // last printed rather than what the token carries.
    if (wordCharacter(lastCharacter) && wordCharacter(text[0])) {
      emit(
        " ",
        options.origins.synthesized(token.origin, "printer-separator"),
        "synthesized",
      );
    }
    const start = offset;
    emit(text, token.origin, kind);
    const trailing = token.trailingTrivia.map(({ raw }) => raw).join("");
    emit(trailing, token.origin, "synthesized");
    tokenSpans.push(
      Object.freeze({ syntax: token.id, start, end: start + text.length }),
    );
  };
  while (pending.length > 0) {
    const item = pending.pop()!;
    if ("grouping" in item) {
      if (item.text === "(") {
        pendingOpens.push({ text: item.text, origin: item.origin });
        continue;
      }
      flushOpens();
      emit(item.text, item.origin, "grouping");
      continue;
    }
    switch (item.tag) {
      case "missing":
        break;
      case "token":
        pushToken(item);
        break;
      case "group":
        pending.push(item.close);
        pushChildren(
          item.children,
          item.delimiter === "parenthesis" || item.delimiter === "bracket",
        );
        pending.push(item.open);
        break;
      case "root":
        pushChildren(item.children);
        break;
      case "protected": {
        // Parentheses exist to preserve precedence, which a lone token never
        // needs. Adding them anyway produces `{ (x) }` for a shorthand
        // property, which is not an object literal member at all.
        //
        // Nor does anything without an operator of its own to protect: a call,
        // a member chain, a literal or a group cannot be re-associated by what
        // surrounds it, and wrapping those turned readable output into nests
        // of redundant parentheses.
        const binds =
          item.category === "type" ? typeBindingOperator : bindingOperator;
        // A conditional or an arrow is spelled with `?`, `:` and `=>`, which
        // bind nothing elsewhere, so reading its tokens called it atomic:
        // `$v * 2` with `$v` bound to `c ? 1 : 2` printed `c ? 1 : 2 * 2`, and
        // `$f(1)` with an arrow printed a call on the arrow's body. The form
        // the parser recorded says it has an operator of its own.
        const atomic =
          item.form === undefined &&
          ((item.children.length === 1 && item.children[0]!.tag === "token") ||
            !item.children.some(
              (child) => child.tag === "token" && binds(child),
            ));
        const group =
          (item.category === "expr" || item.category === "type") &&
          !atomic &&
          !wholeArrowBodies.has(item) &&
          !boundOperands.has(item) &&
          (options.groupProtectedExpression?.(item) ?? true);
        if (group)
          pending.push({ text: ")", origin: item.origin, grouping: true });
        markBoundOperands(item);
        pushChildren(item.children);
        if (group)
          pending.push({ text: "(", origin: item.origin, grouping: true });
        break;
      }
    }
  }
  flushOpens();
  return Object.freeze({
    text: chunks.join(""),
    originMap: Object.freeze({
      schemaVersion: 1 as const,
      entries: Object.freeze(entries),
    }),
    tokenSpans: Object.freeze(tokenSpans),
    trace: options.trace,
    serializedTrace: serializeExpansionTrace(options.trace),
  });
}
