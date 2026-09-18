import * as ts from "typescript";

/**
 * A sentence expansion holds about a name it left standing, and the name it is
 * about.
 *
 * Expansion is not the side that knows what a name means. It sees the macros
 * in scope and the bindings a module writes, and never `lib.d.ts`, an ambient
 * declaration, a `declare global`, or that a member list names members of its
 * own -- so a macro spelled `Partial` made `type Halved = Partial<{ a:
 * number }>` fail to build, over a name the standard library declares. The
 * sentence is therefore held rather than reported, for whichever side of the
 * pipeline can answer for the name.
 *
 * The name travels with it because a position is not enough to tell two of
 * these apart. A macro's expansion is reported against the invocation that
 * wrote it, so every name in one expansion shares a file and an offset.
 */
export interface UnresolvedNameExplanation {
  /** The name the sentence is about, as it was written. */
  readonly name: string;
  /** The sentence, positioned where the name was written. */
  readonly diagnostic: ts.Diagnostic;
}

/**
 * What TypeScript says when it cannot find a value for a name. A macro written
 * outside the space it was declared for is emitted verbatim, so this is where
 * it surfaces.
 */
const unresolvedNameCodes: ReadonlySet<number> = new Set([
  2304, // Cannot find name 'X'.
  2552, // Cannot find name 'X'. Did you mean 'Y'?
  7008, // Member 'X' implicitly has an 'any' type.
  18004, // No value exists in scope for the shorthand property 'X'.
]);

/**
 * What TypeScript says when it finds the name, in the other space.
 *
 * These answer only for `SWR4013`, which says a macro is declared for one
 * space and written where another is read -- the same mistake in TypeScript's
 * vocabulary, and with advice ("Did you mean 'typeof Thing'?") that is wrong
 * when the macro was what was meant.
 *
 * They do not answer for `SWR4017` or `SWR4024`. Those rest on nothing else
 * defining the name, and a name TypeScript found in the other space is a name
 * it found.
 */
const resolvedInAnotherSpaceCodes: ReadonlySet<number> = new Set([
  2693, // 'X' only refers to a type, but is being used as a value here.
  2749, // 'X' refers to a value, but is being used as a type here.
]);

/** `SWR4013`, the sentence about a macro declared for another space. */
const wrongCategoryMacroCode = 4013;

/** Whether a held sentence is an answer to what TypeScript said here. */
function answers(
  typescriptCode: number,
  explanationCode: number | undefined,
): boolean {
  return (
    unresolvedNameCodes.has(typescriptCode) ||
    (explanationCode === wrongCategoryMacroCode &&
      resolvedInAnotherSpaceCodes.has(typescriptCode))
  );
}

/** The file and offset a diagnostic is about, where it is about one. */
function diagnosticPlace(diagnostic: ts.Diagnostic): string | undefined {
  return diagnostic.file === undefined || diagnostic.start === undefined
    ? undefined
    : `${diagnostic.file.fileName}:${String(diagnostic.start)}`;
}

/**
 * The name TypeScript's sentence is about.
 *
 * Read out of the message rather than out of the source, because the span has
 * been mapped back to the invocation that wrote the name and the text there is
 * the macro call, not the name. Every message these codes carry names the
 * identifier first and in quotes.
 */
function nameTypeScriptNamed(diagnostic: ts.Diagnostic): string | undefined {
  if (
    !unresolvedNameCodes.has(diagnostic.code) &&
    !resolvedInAnotherSpaceCodes.has(diagnostic.code)
  )
    return undefined;
  const quoted = /'([^']+)'/u.exec(
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
  return quoted?.[1];
}

export interface ExplainedDiagnostics {
  readonly diagnostics: readonly ts.Diagnostic[];
  /** The held sentences TypeScript asked for. */
  readonly spoken: ReadonlySet<UnresolvedNameExplanation>;
}

/**
 * Say what expansion knows about the names TypeScript could not resolve.
 *
 * TypeScript resolves every name, against the whole program. Where it reports
 * one is missing at a position and under a name expansion has something to say
 * about, its sentence is replaced by the one that names the macro: the
 * position and the name are the same, and the macro is the answer rather than
 * a restatement of the question. Where it reports nothing about that name,
 * nothing is said in its place.
 *
 * Matched on the name as well as the position. A macro that writes several
 * names writes them all at one position, and matching on the position alone
 * let one sentence stand in for every error in the expansion -- the other
 * names' errors were replaced by it and then deduplicated away -- while of two
 * sentences held against one position only the last was ever written.
 */
export function explainUnresolvedNames(
  diagnostics: readonly ts.Diagnostic[],
  explanations: readonly UnresolvedNameExplanation[],
): ExplainedDiagnostics {
  const spoken = new Set<UnresolvedNameExplanation>();
  if (explanations.length === 0) return Object.freeze({ diagnostics, spoken });
  const byPlaceAndName = new Map<string, UnresolvedNameExplanation[]>();
  for (const explanation of explanations) {
    const at = diagnosticPlace(explanation.diagnostic);
    if (at === undefined) continue;
    const key = `${at}:${explanation.name}`;
    const held = byPlaceAndName.get(key);
    if (held === undefined) byPlaceAndName.set(key, [explanation]);
    else held.push(explanation);
  }
  const answered = diagnostics.map((diagnostic) => {
    const at = diagnosticPlace(diagnostic);
    const name = nameTypeScriptNamed(diagnostic);
    if (at === undefined || name === undefined) return diagnostic;
    const candidates = (byPlaceAndName.get(`${at}:${name}`) ?? []).filter(
      (candidate) => answers(diagnostic.code, candidate.diagnostic.code),
    );
    // One sentence answers for every copy of the error a repeated argument
    // produced, and two sentences held against one position each answer for
    // their own, so an unspoken one is preferred and the last is reused.
    const explanation =
      candidates.find((candidate) => !spoken.has(candidate)) ??
      candidates[candidates.length - 1];
    if (explanation === undefined) return diagnostic;
    spoken.add(explanation);
    return explanation.diagnostic;
  });
  return Object.freeze({ diagnostics: answered, spoken });
}

/**
 * The held sentences, said as warnings, where nothing will ever answer them.
 *
 * A path that expands without checking -- `emit`, `expand`, a build tool's
 * transform, a file the project's TypeScript does not check -- has no side to
 * hand these to. The choice there is between saying the sentence with its one
 * unverifiable claim in it, that nothing else defines the name, and saying
 * nothing at all; and nothing at all means the macro name is written into the
 * output in silence, to be met as a `ReferenceError` or as a bare `Cannot find
 * name` in some other project.
 *
 * It is said, as a warning rather than an error, because the claim it cannot
 * make is the one that would justify refusing the output: a macro spelled like
 * a global leaves that global standing, and the emitted text is then correct.
 */
export function warnAboutHeldNames(
  explanations: readonly UnresolvedNameExplanation[],
): readonly ts.Diagnostic[] {
  return Object.freeze(
    explanations.map(({ diagnostic }) =>
      Object.freeze({
        ...diagnostic,
        category: ts.DiagnosticCategory.Warning,
      }),
    ),
  );
}
