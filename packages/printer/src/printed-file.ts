import type { OriginId, SyntaxId } from "@sweetener/shared";
import {
  angleWidth,
  assignmentPrecedence,
  commaPrecedence,
  type DelimiterKind,
  isReservedWord,
  operatorPrecedence,
  type MissingToken,
  type Origin,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type TokenSyntax,
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
    }
  /**
   * Entering JSX, where whitespace is content, or code inside it -- an
   * attribute's or a child's braces -- and leaving either.
   */
  | { readonly jsx: "text" | "code" | "leave" };

/** The angles a generic arrow's type parameters are written between. */
interface ArrowTypeParameters {
  readonly open: TokenSyntax;
  readonly close: TokenSyntax;
  /**
   * Whether they are written in the one way a `.tsx` file cannot read:
   * `<T>(value: T) => value`.
   *
   * There the `<T>` opens an element, and TypeScript reads type parameters
   * only where a comma or an `extends` stands directly inside the angles --
   * `<T,>` and `<T extends U>`. A template is written in whichever file defines
   * the macro and printed into whichever file invokes it, so a `.sts` macro's
   * `<T>` is printed into `.tsx` whenever a `.stsx` file uses it; and generated
   * `.ts` is read as `.tsx` by whatever it is pasted into, the TypeScript
   * playground first among them. The comma is the spelling both files read, so
   * the printer writes it wherever it is missing.
   */
  readonly needsComma: boolean;
}

/**
 * The type parameters `arrow` begins with, if it is an arrow and has any.
 *
 * Only for a node the parser recorded as an arrow. `<T>(value)` is also a type
 * assertion, which a comma would break, and `async < T` is also a comparison;
 * nothing about the tokens says which is meant, and the parser already has.
 */
function arrowTypeParameters(
  arrow: ProtectedSyntax,
): ArrowTypeParameters | undefined {
  if (arrow.form !== "arrow") return undefined;
  const children = arrow.children;
  let at = 0;
  const first = children[0];
  if (first?.tag === "token" && first.raw === "async") at = 1;
  const open = children[at];
  if (open?.tag !== "token" || open.raw !== "<") return undefined;
  let depth = 0;
  let needsComma = true;
  for (; at < children.length; at += 1) {
    const child = children[at]!;
    if (child.tag !== "token") continue;
    if (depth === 1 && (child.raw === "," || child.raw === "extends"))
      needsComma = false;
    depth += angleWidth(child.raw, "<");
    const closes = angleWidth(child.raw, ">");
    if (closes === 0) continue;
    depth -= closes;
    if (depth > 0) continue;
    // The scanner leaves every `>` a token of its own, so that one of them can
    // close a list; a wider one closing this list was never scanned.
    if (depth < 0 || closes !== 1)
      throw new Error(
        `Cannot print a generic arrow whose type parameters close with \`${child.raw}\`: no comma can be written inside that token`,
      );
    return { open, close: child, needsComma };
  }
  return undefined;
}

/** A prefix type assertion, `<A>value`, as the two things it is written with. */
interface PrefixTypeAssertion {
  readonly type: readonly Syntax[];
  readonly operand: Syntax;
}

/**
 * The prefix type assertion `node` is, if it is one.
 *
 * It is printed as `(value as A)`, which is the same expression and the only
 * spelling of it a `.tsx` file can read: there a `<` where an operand begins
 * opens an element. A template is written in the file that defines the macro
 * and printed into the file that invokes it, so a `.sts` macro's `<A>value`
 * reaches `.tsx` whenever a `.stsx` file uses it, and generated `.ts` is read
 * as `.tsx` by whatever it is pasted into. There is no comma to add as there is
 * for a generic arrow.
 *
 * Nothing but an assertion and a generic arrow begins an expression with a `<`
 * token -- an element is a group -- and the two cannot be confused: after the
 * closing `>` an assertion holds its one operand, and an arrow holds at least
 * its parameters, its `=>` and its body.
 */
function prefixTypeAssertion(
  node: ProtectedSyntax,
): PrefixTypeAssertion | undefined {
  if (node.category !== "expr" || node.form !== undefined) return undefined;
  const children = node.children;
  const open = children[0];
  // One `<` and no more: the scanner joins `<<`, and the reader does not take
  // an assertion that opens with one.
  if (open?.tag !== "token" || open.raw !== "<") return undefined;
  let depth = 0;
  for (let at = 0; at < children.length; at += 1) {
    const child = children[at]!;
    if (child.tag !== "token") continue;
    depth += angleWidth(child.raw, "<") - angleWidth(child.raw, ">");
    if (depth > 0) continue;
    return depth === 0 && at > 1 && at === children.length - 2
      ? {
          type: children.slice(1, at),
          operand: children[at + 1]!,
        }
      : undefined;
  }
  return undefined;
}

/** Punctuators two adjacent tokens could print as, if nothing parted them. */
const punctuators: readonly string[] = [
  "++",
  "--",
  "**",
  "=>",
  "==",
  "===",
  "!=",
  "!==",
  "<=",
  "&&",
  "||",
  "??",
  "?.",
  "...",
  "<<",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**=",
  "<<=",
  "&&=",
  "||=",
  "??=",
  "//",
  "/*",
];

/**
 * Every way a punctuator splits in two, gathered by the piece on the left: the
 * same question `punctuators` asks, answered once at load instead of by
 * cutting all thirty of them apart again at every seam.
 */
const punctuatorJoins: ReadonlyMap<string, readonly string[]> = (() => {
  const joins = new Map<string, string[]>();
  for (const punctuator of punctuators)
    for (let split = 1; split < punctuator.length; split += 1) {
      const head = punctuator.slice(0, split);
      const tail = punctuator.slice(split);
      const tails = joins.get(head);
      if (tails === undefined) joins.set(head, [tail]);
      else if (!tails.includes(tail)) tails.push(tail);
    }
  return joins;
})();

/** The longest such left piece: no longer ending of `left` can begin one. */
const longestJoinHead = Math.max(
  ...[...punctuatorJoins.keys()].map((head) => head.length),
);

/** The characters one can end with, so a word ending is dismissed at a glance. */
const joinHeadEnds: ReadonlySet<string> = new Set(
  [...punctuatorJoins.keys()].map((head) => head[head.length - 1]!),
);

/** Whether two adjacent pieces would lex as one longer punctuator. */
function joinsIntoOne(left: string, right: string): boolean {
  if (left.length === 0 || !joinHeadEnds.has(left[left.length - 1]!))
    return false;
  const longest = Math.min(longestJoinHead, left.length);
  for (let length = 1; length <= longest; length += 1) {
    const tails = punctuatorJoins.get(left.slice(left.length - length));
    if (tails === undefined) continue;
    for (const tail of tails) if (right.startsWith(tail)) return true;
  }
  return false;
}

/**
 * Words that stand before an operand rather than ending one.
 *
 * `isReservedWord` leaves the contextual keywords out so they keep working as
 * ordinary names, which is what they are wherever a binding or a reference is
 * expected. In front of a parenthesis that is exactly the distinction that
 * matters: `keyof (A | B)` operates on what follows it, where `values.of(1)`
 * calls what precedes it.
 */
const operandHeads: ReadonlySet<string> = new Set([
  "as",
  "asserts",
  "async",
  "infer",
  "is",
  "keyof",
  "of",
  "readonly",
  "satisfies",
]);

/**
 * Whether `(` or `[` after this text calls or indexes it -- that is, whether
 * an operand ends here.
 *
 * A word written after `.` is a property name however it is spelled, so
 * `values.of(1)` is a call and the `<` in `Array.of<string>()` opens type
 * arguments. A closing bracket says by its spelling only what usually
 * follows it, and `ends` is what the syntax says where the two differ: the
 * `}` of an object literal or a function expression ends an operand, and the
 * `)` of an `if` header does not.
 */
function applies(
  text: string,
  memberName: boolean,
  ends: boolean | undefined,
): boolean {
  if (ends !== undefined) return ends;
  if (text === ")" || text === "]" || text === ">" || text.endsWith("`"))
    return true;
  if (!/^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(text)) return false;
  if (memberName) return true;
  // `this`, `super` and `import` are called; every other reserved word, and
  // the contextual ones that head an operand, stands before one.
  return (
    text === "this" ||
    text === "super" ||
    text === "import" ||
    !(isReservedWord(text) || operandHeads.has(text))
  );
}

/**
 * Tokens after which a whole assignment expression is written, where nothing
 * after it but a separator or the end of its brackets belongs to it.
 */
const wholeExpressionHeads: ReadonlySet<string> = new Set([
  "...",
  "=",
  "return",
  "throw",
  "default",
]);

/**
 * The keywords whose parenthesized header a statement follows: `if (ready)
 * (value)` is a statement after a header, not a call on it.
 */
const controlHeads: ReadonlySet<string> = new Set([
  "if",
  "while",
  "for",
  "with",
  "switch",
]);

/** Tokens nothing is written after: what follows stands against them. */
const holdsWhatFollows: ReadonlySet<string> = new Set([
  "(",
  "[",
  ".",
  "?.",
  "...",
  "!",
  "~",
  "#",
  "@",
]);

/** Tokens nothing is written before: they stand against what precedes them. */
const holdsToWhatPrecedes: ReadonlySet<string> = new Set([
  ")",
  "]",
  ",",
  ";",
  ".",
  "?.",
]);

/** Tokens a line break after which can end a statement. */
const endsAnOperand: ReadonlySet<string> = new Set([
  ";",
  "{",
  "}",
  ")",
  "]",
  "this",
  "super",
  "null",
  "true",
  "false",
]);

/** What a `<` written after it opens type arguments rather than compares. */
const typeArgumentsCanFollow: ReadonlySet<string> = new Set([
  "(",
  ",",
  "=",
  "=>",
  ":",
  "?",
  "[",
  "{",
]);

/** Where a seam stands, as far as spacing it needs to know. */
interface SeamContext {
  /**
   * The innermost bracket open around it: `(`, `[`, `{`, `<` for type
   * arguments, or none.
   */
  readonly bracket: string | undefined;
  /** Whether a conditional's `?` in that bracket still awaits its `:`. */
  readonly conditional: boolean;
  /** Whether the `-`, `+` or `<` just printed stands before an operand. */
  readonly prefix: boolean;
  /** Whether the word just printed was written after `.`, and so names a member. */
  readonly memberName: boolean;
  /**
   * Whether the bracket just printed closed an operand, where the syntax says
   * otherwise than its spelling would.
   */
  readonly closedOperand: boolean | undefined;
  /** Whether the `>` just printed closed a list of type arguments. */
  readonly closedTypeArguments: boolean;
}

/**
 * The space between two tokens that an expansion put next to each other.
 *
 * What stood in front of a token where it was written describes its gap from
 * the token that stood before it there, not from whatever an expansion places
 * before it in the output: the space after `=` in `total = [1, 2, 3]` belongs
 * to `[`, and would follow `[` into `map( [1, 2, 3]`. At such a seam the gap is decided the
 * way code is ordinarily spaced instead.
 */
function seamSpace(left: string, right: string, context: SeamContext): string {
  // The reader leaves `>>`, `>=` and the rest of the `>` family as separate
  // `>` tokens so nested type arguments close, and they are printed whole
  // however they reached each other. A `>` that did close type arguments is
  // no part of one: the `=` after `Array<string>` opens a default, and
  // printed against it the scanner reads a `>=` it has to take apart again.
  if (
    left.endsWith(">") &&
    !context.closedTypeArguments &&
    (right === ">" || right.startsWith("="))
  )
    return "";
  if (joinsIntoOne(left, right)) return " ";
  // `1.toFixed` is scanned as a malformed decimal literal. A capture ending
  // in an integer can meet a template's member access at this seam.
  if (right === "." && /^[0-9][0-9_]*$/u.test(left)) return " ";
  // Inside a template literal's substitution.
  if (left.endsWith("${") || (right.startsWith("}") && right.length > 1))
    return "";
  // A statement ends here; a `for` loop's header is not a statement list.
  if (left === ";") return context.bracket === "(" ? " " : "\n";
  if (holdsWhatFollows.has(left)) return "";
  if (left === "{") return right === "}" ? "" : " ";
  // A sign, or the `<` that opens type arguments, holds on to what follows.
  if ((left === "-" || left === "+" || left === "<") && context.prefix)
    return "";
  if (right === ">" && context.bracket === "<") return "";
  if (right === ":") return context.conditional ? " " : "";
  if (holdsToWhatPrecedes.has(right)) return "";
  if (right === "}") return " ";
  if (right === "(" || right === "[")
    return applies(left, context.memberName, context.closedOperand) ? "" : " ";
  if (
    (right === "!" || right === "++" || right === "--") &&
    applies(left, context.memberName, context.closedOperand)
  )
    return "";
  return " ";
}

/**
 * Whether a line break after this text could end a statement, and so must not
 * be taken away. After `return`, `throw`, `yield` or any other reserved word a
 * line break would instead end the statement early, so it is not one of these.
 */
function mayEndStatement(text: string): boolean {
  if (endsAnOperand.has(text)) return true;
  if (isReservedWord(text)) return false;
  return /[\p{ID_Continue}$"'`]$/u.test(text);
}

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

/** What ends an arrow's body where it stands in a sequence of nodes. */
const arrowBodyEnds: ReadonlySet<string> = new Set([";", ",", ":"]);

/** Tokens that bind against neighbours, and so need the grouping kept. */

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

/**
 * The precedence an expression holds together at against the operators around
 * it.
 *
 * The parser reads an unparenthesized arrow as one operand, as it reads a
 * call, and records it at primary precedence. TypeScript reads an arrow as an
 * assignment expression, whose body runs on past any operator written after
 * it, so an arrow holds together only where an assignment would: `p && $f`
 * with `$f` an arrow printed `p && () => 1`, which does not parse, and
 * `$f || q` printed an arrow that returns `1 || q`.
 */
function holdingPrecedence(expression: ProtectedSyntax): number | undefined {
  return expression.form === "arrow"
    ? assignmentPrecedence
    : expression.precedence;
}

/**
 * The places where an expression begins something whose grammar keeps certain
 * tokens out of its first place: an expression statement, an arrow's concise
 * body, and what `export default` exports. An expression that begins with one
 * of those tokens there is read as something else.
 */
type LeadingPosition = "statement" | "arrow body" | "export default";

/**
 * Whether `expression`, standing first in `position`, begins with a token
 * TypeScript reads there as something other than an expression.
 *
 * ECMAScript writes these as lookahead restrictions. A statement beginning
 * with `{` is a block and one beginning with `function`, `async function` or
 * `class` is a declaration, so `$v;` with `$v` an object literal printed a
 * block holding a label, and `$f();` with `$f` a function expression printed
 * a declaration with no name. An arrow's body beginning with `{` is a block,
 * so `() => $v` printed a function that returns nothing. `export default`
 * reads `function` and `class` as declarations too, but an object literal as
 * the object it is.
 */
function misreadAt(
  expression: ProtectedSyntax,
  position: LeadingPosition,
): boolean {
  const [first, second] = expression.children;
  if (first?.tag === "group")
    return first.delimiter === "brace" && position !== "export default";
  if (first?.tag !== "token" || position === "arrow body") return false;
  return (
    first.raw === "function" ||
    first.raw === "class" ||
    (first.raw === "async" &&
      second?.tag === "token" &&
      second.raw === "function")
  );
}

/**
 * The expression `expression` is. A node holding nothing but another
 * expression -- a capture of one, a macro's result that is one -- is that
 * expression, and stands wherever it stands: its own precedence is the one
 * the parser gave the wrapper, not the one the expression inside binds at.
 */
function unwrapped(expression: ProtectedSyntax): ProtectedSyntax {
  let current = expression;
  for (;;) {
    const [sole] = current.children;
    if (
      current.children.length !== 1 ||
      sole?.tag !== "protected" ||
      sole.category !== "expr"
    )
      return current;
    current = sole;
  }
}

/**
 * Whether a postfix chain holds `?.`. Whatever is written after it joins the
 * chain and is skipped along with it when the chain short-circuits, so a
 * chain that something else continues keeps its parentheses: `$v()` with
 * `$v` bound to `a?.b` is `(a?.b)()`, which throws where `a` is missing, and
 * `a?.b()` does not.
 */
function optionalChain(expression: ProtectedSyntax): boolean {
  const inner = unwrapped(expression);
  return inner.children.some(
    (child) => child.tag === "token" && child.raw === "?.",
  );
}

/**
 * Whether what `new` constructs would take arguments or an optional chain of
 * its own along with it: `new $C()` with `$C` bound to `make()` is
 * `new (make())()`, and `new make()()` constructs `make` and calls the result.
 * Neither a function expression's parameters nor a call in a class
 * expression's heritage is an argument list of its own, and an operand nested
 * anywhere but at the head is bounded by what precedes it.
 */
function constructsTooMuch(expression: ProtectedSyntax): boolean {
  const [head] = expression.children;
  if (
    head?.tag === "token" &&
    (head.raw === "function" || head.raw === "class")
  )
    return false;
  return (
    optionalChain(expression) ||
    expression.children.some(
      (child, at) =>
        at > 0 && child.tag === "group" && child.delimiter === "parenthesis",
    ) ||
    (head?.tag === "protected" &&
      head.category === "expr" &&
      constructsTooMuch(head))
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
   * The line being written: how many line breaks precede it, the whitespace it
   * began with, and whether anything but whitespace has landed on it yet.
   */
  let lineNumber = 0;
  let lineIndent = "";
  let lineStarted = false;
  const trackLine = (text: string) => {
    let tail = text;
    if (text.includes("\n") || text.includes("\r")) {
      const lines = text.split(/\r\n|[\n\r]/u);
      lineNumber += lines.length - 1;
      lineIndent = "";
      lineStarted = false;
      tail = lines[lines.length - 1]!;
    }
    if (lineStarted) return;
    const blank = /^[^\S\r\n]*/u.exec(tail)![0];
    lineIndent += blank;
    if (blank.length < tail.length) lineStarted = true;
  };
  /**
   * The nodes that are the whole body of an arrow. An arrow's body is parsed
   * as an expression, so it arrives here as one protected node; wrapping that
   * in parentheses would print `(value: number) => (value + 1)`, which is the
   * same function spelled worse. Nothing to either side of a body can re-associate
   * into it -- it runs to the end of the arrow -- so nothing has to hold it
   * together.
   *
   * Only a node that ends where the body does. Exempting whatever is printed
   * first after `=>` would also exempt the callee of a call that is the body:
   * `(x) => $f(x)` with `$f` an arrow would print `(x) => (n) => n * 2(x)`.
   */
  const wholeArrowBodies = new Set<Syntax>();
  /**
   * The first tokens of statements and items that follow something else in
   * the same list. Where an expansion puts one after what came before, it
   * begins a line: two items a template writes in separate `#core` forms
   * printed as `type F<T> = Array<T> export interface Functor`.
   */
  const statementStarts = new Set<Syntax>();
  /**
   * Expressions that stand first in a statement, an arrow's concise body or an
   * `export default`, and the one place each stands. An expression passes its
   * place on to the operand it begins with, unless it is parenthesized itself.
   */
  const leadingPositions = new Map<Syntax, LeadingPosition>();
  /**
   * Expressions a call, an access, a tagged template or a `new` would reach
   * into and take part of, if they were printed without parentheses.
   */
  const continuedHeads = new Set<Syntax>();
  /**
   * Closing brackets whose spelling misleads the spacing after them, and
   * whether each ends an operand: the `}` of an expression's own braces --
   * an object literal, a function or class expression -- which a call or an
   * operator may follow, and the `)` of a control statement's header, which a
   * statement does.
   */
  const closerEnds = new Map<Syntax | MissingToken, boolean>();
  /** Each `<` the parser read as opening an arrow's type parameters. */
  const typeParameterOpens = new Set<Syntax>();
  /** Each `>` closing type parameters that `needsComma` before it. */
  const commaBeforeClose = new Set<Syntax>();
  const firstToken = (node: Syntax): Syntax | undefined => {
    let current: Syntax | undefined = node;
    while (current !== undefined && current.tag !== "token")
      current = current.tag === "group" ? current.open : current.children[0];
    return current;
  };
  /**
   * Operands that already bind tighter than the operator the parser read them
   * under, so they hold together without parentheses: `value * 2` in
   * `value * 2 + 1`.
   */
  const boundOperands = new Set<Syntax>();
  /**
   * Marks an expression that stands as a whole assignment expression or more,
   * which nothing around it can re-associate. Only a comma expression, or one
   * whose precedence is unknown, could run on into what follows.
   */
  const markWhole = (expression: ProtectedSyntax) => {
    const inner = unwrapped(expression);
    if (inner.form !== undefined || (inner.precedence ?? 0) > commaPrecedence)
      boundOperands.add(inner);
  };
  const markBoundOperands = (parent: ProtectedSyntax) => {
    const precedence = parent.precedence;
    if (parent.category !== "expr" || precedence === undefined) return;
    const children = parent.children;
    const operand = (node: Syntax | undefined) => {
      if (node?.tag !== "protected" || node.category !== "expr")
        return undefined;
      const inner = unwrapped(node);
      return inner.precedence === undefined ? undefined : inner;
    };
    const bind = (node: Syntax | undefined, minimum: number) => {
      const found = operand(node);
      if (found !== undefined && holdingPrecedence(found)! >= minimum)
        boundOperands.add(found);
    };
    if (parent.form === "conditional") {
      // `test ? consequent : alternate`: the test is a short-circuit
      // expression, the consequent anything short of a comma, and the
      // alternate an assignment-level one.
      bind(children[0], operatorPrecedence("??", "infix"));
      bind(children[2], commaPrecedence + 1);
      bind(children[4], assignmentPrecedence);
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
        node?.precedence === operatorPrecedence("||", "infix") ||
        node?.precedence === operatorPrecedence("&&", "infix");
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
    // what is constructed. `yield` takes a whole assignment expression.
    if (first?.tag === "token" && first.raw !== "new" && children.length === 2)
      bind(last, parent.form === "yield" ? precedence : precedence + 1);
  };
  const emit = (text: string, origin: OriginId, kind: GeneratedRegionKind) => {
    if (text.length === 0) return;
    const start = offset;
    chunks.push(text);
    offset += text.length;
    lastCharacter = text[text.length - 1];
    trackLine(text);
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
  /**
   * Whether a template wrote `syntax`, rather than the author of the file being
   * printed. Only that is respelled for the file it lands in: a template is
   * written for the file that defines its macro, and the author's own code was
   * written for this one, in the spelling they chose. It is the rule grouping
   * parentheses already follow.
   */
  const writtenByTemplate = (syntax: Syntax): boolean =>
    kindFor(syntax.origin) === "introduced";
  const pending: PrintItem[] = [...options.syntax].reverse();
  const pushChildren = (children: readonly Syntax[], group?: DelimiterKind) => {
    const list = group === "parenthesis" || group === "bracket";
    // A parenthesis group holding `;` is a `for` header, and the clause before
    // its first `;` is the one place an expression may not hold `in` outside
    // parentheses: `for (("a" in o); ;)` is not `for ("a" in o; ;)`.
    const firstSemicolon =
      group === "parenthesis"
        ? children.findIndex(
            (child) => child.tag === "token" && child.raw === ";",
          )
        : -1;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      const previous = children[index - 1];
      const before = children[index - 2];
      const next = children[index + 1];
      if (
        previous?.tag === "token" &&
        previous.raw === "=>" &&
        (next === undefined ||
          (next.tag === "token" && arrowBodyEnds.has(next.raw)))
      )
        wholeArrowBodies.add(
          child.tag === "protected" && child.category === "expr"
            ? unwrapped(child)
            : child,
        );
      if (child.tag === "protected" && child.category === "expr") {
        // Asked of the nodes on either side rather than of a parent: a call
        // or an access need not be a node of its own, and in an arrow's body
        // it is often only a run of siblings.
        const continued =
          (next?.tag === "token" && next.raw === ".") ||
          (next?.tag === "group" &&
            (next.delimiter === "parenthesis" ||
              next.delimiter === "bracket" ||
              next.delimiter === "template"));
        if (
          previous?.tag === "token" && previous.raw === "new"
            ? constructsTooMuch(child)
            : continued && optionalChain(child)
        )
          continuedHeads.add(unwrapped(child));
        if (previous?.tag === "token" && previous.raw === "=>")
          leadingPositions.set(child, "arrow body");
        if (
          previous?.tag === "token" &&
          previous.raw === "default" &&
          before?.tag === "token" &&
          before.raw === "export"
        )
          leadingPositions.set(child, "export default");
      }
      // An argument or an array element is a whole assignment expression, so
      // an arrow, a conditional or an operator expression written as one
      // needs no parentheses of its own: `map(values, (n) => n * 10)`. Only a
      // comma expression, or an expression whose precedence is unknown,
      // could run into the next element.
      //
      // A `for` header's test and update stand the same way, parted by `;`
      // instead -- the only place a semicolon separates expressions inside
      // brackets -- so `for (let at = 0; at < 2; at += 1)` needs no
      // parentheses either.
      //
      // So does what a spread spreads, an initializer or a default after
      // `=`, what `return`, `throw` or `export default` is followed by, and
      // what follows a `:` written directly in braces: an object literal's
      // property value, or the statement after a label or a `case`. Each is
      // a whole assignment expression or more. None of them can be the clause
      // of a `for` header that keeps `in` out except an initializer, which is
      // asked about that clause like any other; a parenthesis group's `:`
      // could be one.
      const separates = (node: Syntax | undefined) =>
        node?.tag === "token" && (node.raw === "," || node.raw === ";");
      const opensWhole = (node: Syntax | undefined) =>
        node === undefined
          ? list
          : separates(node) ||
            (node.tag === "token" &&
              (wholeExpressionHeads.has(node.raw) ||
                (group === "brace" && node.raw === ":")));
      if (
        child.tag === "group" &&
        child.delimiter === "parenthesis" &&
        previous?.tag === "token" &&
        (controlHeads.has(previous.raw) ||
          // `for await (...)`.
          (previous.raw === "await" &&
            before?.tag === "token" &&
            before.raw === "for"))
      )
        closerEnds.set(child.close, false);
      // A control statement's body follows its header on the same line.
      const heads =
        previous === undefined ||
        (previous.tag === "group" && previous.delimiter === "parenthesis") ||
        (previous.tag === "token" &&
          ["else", "do", ":", "=>"].includes(previous.raw));
      if (
        child.tag === "protected" &&
        (child.category === "stmt" || child.category === "item") &&
        !heads
      ) {
        const first = firstToken(child);
        if (first !== undefined) statementStarts.add(first);
      }
      if (
        child.tag === "protected" &&
        child.category === "expr" &&
        !(firstSemicolon >= 0 && index < firstSemicolon) &&
        opensWhole(previous) &&
        (next === undefined ? group !== undefined : separates(next))
      )
        markWhole(child);
      // A type argument is a whole type, as an argument is a whole
      // expression: `useRef<HTMLInputElement | null>` needs nothing around
      // the union. The angles are tokens rather than a group, so it is asked
      // of them.
      const listsTypes = (node: Syntax | undefined, closer: string) =>
        node?.tag === "token" && (node.raw === "," || node.raw === closer);
      if (
        child.tag === "protected" &&
        child.category === "type" &&
        listsTypes(previous, "<") &&
        listsTypes(next, ">")
      )
        boundOperands.add(child);
      pending.push(child);
    }
  };
  // A grouping parenthesis stands outside the layout that separates the
  // expansion from whatever precedes it. Emitted the moment it is reached, it
  // would land before the first token's leading trivia and print
  // `const value: number =( 1 + 2) * 10` — the space belongs before the
  // parenthesis, not after it. Holding it until a token is actually printed
  // puts it where it reads.
  const pendingOpens: { readonly text: string; readonly origin: OriginId }[] =
    [];
  const flushOpens = () => {
    for (const open of pendingOpens) {
      emit(open.text, open.origin, "grouping");
      trackBrackets(open.text, "");
      closedOperand = undefined;
      lastPrinted = open.text;
      previousWritten = undefined;
    }
    pendingOpens.length = 0;
  };
  /**
   * Where a token was written: its position in the file that holds it. A
   * token a template wrote is placed at its invocation, so its own span says
   * nothing about its neighbours in the template; its origin records where
   * the template wrote it.
   */
  interface WrittenAt {
    readonly sourceId: number;
    readonly start: number;
    readonly end: number;
  }
  // An origin's record never changes once it is minted, and an expansion
  // hands the same origin to run after run of copied tokens, so the walk down
  // to the source is worth doing once per origin rather than once per token.
  const writtenPlaces = new Map<OriginId, WrittenAt | undefined>();
  const writtenAt = (origin: OriginId): WrittenAt | undefined => {
    const remembered = writtenPlaces.get(origin);
    if (remembered !== undefined || writtenPlaces.has(origin))
      return remembered;
    const record = options.origins.get(origin);
    let answer: WrittenAt | undefined;
    switch (record?.kind) {
      case "source":
        answer = {
          sourceId: record.sourceId,
          start: record.span.start,
          end: record.span.end,
        };
        break;
      case "copied":
        answer = writtenAt(record.parent);
        break;
      case "introduced":
        answer = writtenAt(record.definition);
        break;
      default:
        answer = undefined;
    }
    writtenPlaces.set(origin, answer);
    return answer;
  };
  /** The text last printed, a token or a grouping parenthesis. */
  let lastPrinted: string | undefined;
  /** What kind of origin the last token printed had. */
  let previousKind: Origin["kind"] | undefined;
  /** Where the last token printed was written, unless something followed it. */
  let previousWritten: ReturnType<typeof writtenAt>;
  /** Whether each JSX region or code region in it holds text, innermost last. */
  const jsxRegions: boolean[] = [];
  /** Whether JSX braces just opened, before the code in them. */
  let jsxCodeOpened = false;
  /**
   * The brackets open around what is being printed, innermost last. Each
   * remembers the line it opened on, so a line the printer begins inside it
   * can be indented past the line the bracket stands on. The file itself is
   * no bracket, and its lines are already where they belong.
   */
  const brackets: {
    bracket: string | undefined;
    /**
     * How many conditionals opened in that bracket still await their `:`.
     * Counted rather than held as a flag, because a conditional written in
     * another's consequent closes with a `:` of its own and the outer one is
     * still open after it: the `:` of `c ? c ? 1 : 2 : 3` that the first
     * answers is not the one the second does.
     */
    conditionals: number;
    readonly openLine: number;
    readonly openIndent: string;
  }[] = [{ bracket: undefined, conditionals: 0, openLine: -1, openIndent: "" }];
  /**
   * The indentation a line the printer begins itself takes before this text:
   * the one this block's own lines stand at, or a step past the line its
   * bracket opened on until a line has been written inside it. A bracket's
   * own closer stands back out at the line the bracket opened on.
   */
  const brokenLineIndent = (text: string): string => {
    const innermost = brackets[brackets.length - 1]!;
    if (text === ")" || text === "]" || text.startsWith("}"))
      return innermost.openIndent;
    if (lineNumber > innermost.openLine) return lineIndent;
    return (
      innermost.openIndent + (innermost.openIndent.includes("\t") ? "\t" : "  ")
    );
  };
  /** Whether the `-`, `+` or `<` last printed stands before an operand. */
  let prefix = false;
  /** Whether the word last printed was written after `.`, and so names a member. */
  let memberName = false;
  /** Whether the `>` last printed closed a list of type arguments. */
  let closedTypeArguments = false;
  /** What `closerEnds` says of the bracket last printed, if anything. */
  let closedOperand: boolean | undefined;
  /**
   * Where the seam about to be printed stands. Only one seam is being spaced
   * at a time and `seamSpace` only reads what it is handed, so the same record
   * is filled in again rather than a fresh one minted per token.
   */
  const seam = {
    bracket: undefined as string | undefined,
    conditional: false,
    prefix: false,
    memberName: false,
    closedTypeArguments: false,
    closedOperand: undefined as boolean | undefined,
  };
  const seamContext = (): SeamContext => {
    const innermost = brackets[brackets.length - 1]!;
    seam.bracket = innermost.bracket;
    seam.conditional = innermost.conditionals > 0;
    seam.prefix = prefix;
    seam.memberName = memberName;
    seam.closedTypeArguments = closedTypeArguments;
    seam.closedOperand = closedOperand;
    return seam;
  };
  const trackBrackets = (
    text: string,
    gap: string,
    opensTypeParameters = false,
  ) => {
    const before = lastPrinted;
    const wasMemberName = memberName;
    const wasClosedOperand = closedOperand;
    const closes =
      text === ")" || text === "]" || text === "}" || text.startsWith("}");
    // A `<` taken for type arguments may never have closed, so a closing
    // bracket first drops any left open inside it.
    if (closes) {
      while (
        brackets.length > 1 &&
        brackets[brackets.length - 1]!.bracket === "<"
      )
        brackets.pop();
      if (brackets.length > 1) brackets.pop();
    }
    closedTypeArguments =
      text === ">" && brackets[brackets.length - 1]!.bracket === "<";
    if (closedTypeArguments) brackets.pop();
    // A word written after `.` is a property name, whatever it is spelled.
    memberName = before === "." || before === "?." || before === "#";
    // `<` written against a name opens type arguments, `useState<number>`,
    // and one where an operand begins opens type parameters, `<T>(value: T)`.
    const typeArguments =
      text === "<" &&
      (opensTypeParameters ||
        before === undefined ||
        (gap === "" && applies(before, wasMemberName, wasClosedOperand)) ||
        typeArgumentsCanFollow.has(before));
    prefix =
      ((text === "-" || text === "+") &&
        (before === undefined ||
          !(
            applies(before, wasMemberName, wasClosedOperand) ||
            /[\p{ID_Continue}"'`]$/u.test(before)
          ))) ||
      typeArguments;
    if (
      text === "(" ||
      text === "[" ||
      text === "{" ||
      text.endsWith("${") ||
      typeArguments
    )
      brackets.push({
        bracket: text.endsWith("${") ? "{" : text,
        conditionals: 0,
        openLine: lineNumber,
        openIndent: lineIndent,
      });
    const innermost = brackets[brackets.length - 1]!;
    if (text === "?") innermost.conditionals += 1;
    // A `?` with its `:` written straight after it marks something optional --
    // `a?: T` -- and opened no conditional, so it gives back what it took.
    else if (text === ":" && innermost.conditionals > 0)
      innermost.conditionals -= 1;
  };
  const pushToken = (token: TokenSyntax) => {
    // Written against the parameter, where a trailing comma stands, and
    // outside what is remembered of the last token printed: the `>` is spaced
    // from the parameter as it was before the comma stood between them.
    if (commaBeforeClose.has(token))
      emit(
        ",",
        options.origins.synthesized(token.origin, "printer-separator"),
        "synthesized",
      );
    const kind = kindFor(token.origin);
    const text = replacements.get(token.id) ?? token.raw;
    const written = writtenAt(token.origin);
    // After `{`, `}` or `;` the statement is already separated.
    const startsStatement =
      statementStarts.has(token) &&
      lastPrinted !== undefined &&
      lastPrinted !== "{" &&
      lastPrinted !== "}" &&
      lastPrinted !== ";";
    // The trivia's text and whether any of it is more than whitespace are
    // both wanted, and reading the pieces once answers both.
    let trivia = "";
    let onlyWhitespace = true;
    for (const piece of token.leadingTrivia) {
      trivia += piece.raw;
      if (piece.kind !== "whitespace") onlyWhitespace = false;
    }
    // The trivia a token was written with is its gap from the token before
    // it there. It is kept where that token is still the one printed before
    // it, and wherever it holds more than a space: a comment, JSX text, or the
    // line break that starts a statement.
    const neighbour =
      previousWritten !== undefined &&
      written !== undefined &&
      previousWritten.sourceId === written.sourceId &&
      previousWritten.end + trivia.length === written.start;
    const keep =
      lastPrinted === undefined ||
      neighbour ||
      jsxRegions.at(-1) === true ||
      !onlyWhitespace ||
      // JSX text carries its own spacing in its text.
      /^\s/u.test(text) ||
      // A line break the author wrote where a statement may end is kept:
      // automatic semicolon insertion reads it.
      ((trivia.includes("\n") || trivia.includes("\r")) &&
        mayEndStatement(lastPrinted!)) ||
      // A template's own token written directly against a placeholder stays
      // against the capture that took its place: `$name<$parameter>` keeps
      // `Result<T>` together.
      (kind === "introduced" &&
        previousKind === "copied" &&
        trivia === "" &&
        !startsStatement) ||
      // A `<` a template wrote directly after a name opens its type
      // arguments, whatever took the name's place.
      (kind === "introduced" &&
        text === "<" &&
        trivia === "" &&
        lastPrinted !== undefined &&
        applies(lastPrinted, memberName, closedOperand));
    const spacing = keep
      ? trivia
      : startsStatement
        ? "\n"
        : // Code a JSX child's or attribute's braces open on holds to them.
          jsxCodeOpened
          ? ""
          : seamSpace(
              lastPrinted!,
              pendingOpens.length > 0 ? "(" : text,
              seamContext(),
            );
    // A line the printer begins itself carries no indentation of its own, and
    // a unit left at column zero reads as though the block had ended. Layout
    // the author wrote already stands where they put it.
    const leading =
      !keep && spacing === "\n"
        ? `${spacing}${brokenLineIndent(text)}`
        : spacing;
    jsxCodeOpened = false;
    // Trivia gets a region of its own so the token's region is exactly the
    // token. A region carries the token's whole source span, and a position
    // inside it is projected by its offset from the region start, so folding
    // the surrounding layout in would shift every offset within the token.
    // The region's kind marks it as layout, and a synthesized region projects
    // to the start of its source span, so the token's own origin serves —
    // minting one per token cost an origin and an intern entry for every
    // piece of trivia in the file.
    emit(leading, token.origin, "synthesized");
    const opensProtected = pendingOpens.length > 0;
    flushOpens();
    if (
      text === "." &&
      leading === "" &&
      !opensProtected &&
      /^[0-9][0-9_]*$/u.test(lastPrinted ?? "")
    )
      emit(
        " ",
        options.origins.synthesized(token.origin, "printer-separator"),
        "synthesized",
      );
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
    let trailing = "";
    for (const piece of token.trailingTrivia) trailing += piece.raw;
    emit(trailing, token.origin, "synthesized");
    trackBrackets(text, leading, typeParameterOpens.has(token));
    closedOperand = closerEnds.get(token);
    lastPrinted = text;
    previousKind = kind;
    previousWritten =
      written === undefined || trailing.length > 0 ? undefined : written;
    tokenSpans.push(
      Object.freeze({ syntax: token.id, start, end: start + text.length }),
    );
  };
  while (pending.length > 0) {
    const item = pending.pop()!;
    if ("jsx" in item) {
      if (item.jsx === "leave") jsxRegions.pop();
      else {
        jsxRegions.push(item.jsx === "text");
        jsxCodeOpened = item.jsx === "code";
      }
      continue;
    }
    if ("grouping" in item) {
      if (item.text === "(") {
        pendingOpens.push({ text: item.text, origin: item.origin });
        continue;
      }
      flushOpens();
      // A word the printer writes stands apart from what it follows; a bracket
      // holds to it.
      if (wordCharacter(item.text[0])) emit(" ", item.origin, "grouping");
      emit(item.text, item.origin, "grouping");
      trackBrackets(item.text, "");
      closedOperand = undefined;
      lastPrinted = item.text;
      previousKind = undefined;
      previousWritten = undefined;
      continue;
    }
    switch (item.tag) {
      case "missing":
        break;
      case "token":
        pushToken(item);
        break;
      case "group": {
        // JSX whitespace is text; inside an attribute's or a child's braces
        // it is code again.
        const region =
          item.delimiter === "jsx-element" || item.delimiter === "jsx-fragment"
            ? "text"
            : item.delimiter === "brace" && jsxRegions.at(-1) === true
              ? "code"
              : undefined;
        // The braces themselves stand among the JSX children; only what they
        // hold is code.
        if (region === "code") pending.push(item.close, { jsx: "leave" });
        else {
          if (region !== undefined) pending.push({ jsx: "leave" });
          pending.push(item.close);
        }
        pushChildren(item.children, item.delimiter);
        if (region === "code") pending.push({ jsx: region }, item.open);
        else {
          pending.push(item.open);
          if (region !== undefined) pending.push({ jsx: region });
        }
        break;
      }
      case "root":
        pushChildren(item.children);
        break;
      case "protected": {
        const assertion = prefixTypeAssertion(item);
        if (assertion !== undefined && writtenByTemplate(item.children[0]!)) {
          // `(value as A)`, pushed last piece first. The parentheses are
          // written whoever wrote the assertion: `as` binds more loosely than
          // the prefix it replaces, so `<A>value * 2` is `(value as A) * 2`
          // even where the author's own grouping is otherwise taken as read.
          const written = (text: string): PrintItem => ({
            text,
            origin: item.origin,
            grouping: true,
          });
          pending.push(written(")"));
          pushChildren(assertion.type);
          pending.push(written("as"));
          // A unary operand holds together against `as` without help.
          if (
            assertion.operand.tag === "protected" &&
            (holdingPrecedence(assertion.operand) ?? 0) >
              operatorPrecedence("as", "infix")
          )
            boundOperands.add(assertion.operand);
          pushChildren([assertion.operand]);
          pending.push(written("("));
          break;
        }
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
        const leading = leadingPositions.get(item);
        const group =
          (item.category === "expr" || item.category === "type") &&
          ((!atomic &&
            !wholeArrowBodies.has(item) &&
            !boundOperands.has(item)) ||
            continuedHeads.has(item) ||
            (leading !== undefined && misreadAt(item, leading))) &&
          (options.groupProtectedExpression?.(item) ?? true);
        if (group)
          pending.push({ text: ")", origin: item.origin, grouping: true });
        const head = item.children[0];
        if (head?.tag === "protected" && head.category === "expr") {
          // An expression statement is a statement that begins with one, and
          // holds it whole.
          if (item.category === "stmt" || item.category === "item") {
            leadingPositions.set(head, "statement");
            const after = item.children[1];
            if (
              after === undefined ||
              (after.tag === "token" && after.raw === ";")
            )
              markWhole(head);
          } else if (leading !== undefined && !group)
            leadingPositions.set(head, leading);
        }
        markBoundOperands(item);
        if (item.category === "expr")
          for (const child of item.children)
            if (child.tag === "group" && child.delimiter === "brace")
              closerEnds.set(child.close, true);
        const typeParameters = arrowTypeParameters(item);
        if (typeParameters !== undefined) {
          typeParameterOpens.add(typeParameters.open);
          if (
            typeParameters.needsComma &&
            writtenByTemplate(typeParameters.open)
          )
            commaBeforeClose.add(typeParameters.close);
        }
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
