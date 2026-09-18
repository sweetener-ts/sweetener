import type { OriginId, SyntaxId } from "@sweetener/shared";
import {
  isReservedWord,
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
 * arguments.
 */
function applies(text: string, memberName: boolean): boolean {
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
    return applies(left, context.memberName) ? "" : " ";
  if (
    (right === "!" || right === "++" || right === "--") &&
    applies(left, context.memberName)
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
      //
      // A `for` header's clauses stand the same way, parted by `;` instead --
      // the only place a semicolon separates expressions inside brackets --
      // so `for (let at = 0; at < 2; at += 1)` needs no parentheses either.
      const separates = (node: Syntax | undefined) =>
        node?.tag === "token" && (node.raw === "," || node.raw === ";");
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
        (child.form !== undefined || (child.precedence ?? 0) > 10) &&
        (previous === undefined ? list : separates(previous)) &&
        (next === undefined ? list : separates(next))
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
  };
  const seamContext = (): SeamContext => {
    const innermost = brackets[brackets.length - 1]!;
    seam.bracket = innermost.bracket;
    seam.conditional = innermost.conditionals > 0;
    seam.prefix = prefix;
    seam.memberName = memberName;
    seam.closedTypeArguments = closedTypeArguments;
    return seam;
  };
  const trackBrackets = (text: string, gap: string) => {
    const before = lastPrinted;
    const wasMemberName = memberName;
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
      (before === undefined ||
        (gap === "" && applies(before, wasMemberName)) ||
        typeArgumentsCanFollow.has(before));
    prefix =
      ((text === "-" || text === "+") &&
        (before === undefined ||
          !(
            applies(before, wasMemberName) ||
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
        applies(lastPrinted, memberName));
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
    let trailing = "";
    for (const piece of token.trailingTrivia) trailing += piece.raw;
    emit(trailing, token.origin, "synthesized");
    trackBrackets(text, leading);
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
      emit(item.text, item.origin, "grouping");
      trackBrackets(item.text, "");
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
        pushChildren(
          item.children,
          item.delimiter === "parenthesis" || item.delimiter === "bracket",
        );
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
