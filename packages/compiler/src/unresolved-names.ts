import {
  heldSentenceAnswers,
  nameTypeScriptNamed,
} from "@sweetener/typescript-host";
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

/** The file and offset a diagnostic is about, where it is about one. */
function diagnosticPlace(diagnostic: ts.Diagnostic): string | undefined {
  return diagnostic.file === undefined || diagnostic.start === undefined
    ? undefined
    : `${diagnostic.file.fileName}:${String(diagnostic.start)}`;
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
    // Expansion holds only sentences about names the author wrote, each at
    // the place it was written; one with no place could never be matched to
    // what TypeScript says, and would be dropped without a word.
    if (at === undefined)
      throw new Error(
        `A sentence was held about ${explanation.name} with no file and position to match TypeScript's answer against.`,
      );
    const key = `${at}:${explanation.name}`;
    const held = byPlaceAndName.get(key);
    if (held === undefined) byPlaceAndName.set(key, [explanation]);
    else held.push(explanation);
  }
  const answered = diagnostics.map((diagnostic) => {
    const at = diagnosticPlace(diagnostic);
    const name = nameTypeScriptNamed(
      diagnostic.code,
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    if (at === undefined || name === undefined) return diagnostic;
    const candidates = (byPlaceAndName.get(`${at}:${name}`) ?? []).filter(
      (candidate) =>
        heldSentenceAnswers(diagnostic.code, candidate.diagnostic.code),
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
    explanations.map(({ diagnostic, name }) =>
      Object.freeze({
        ...diagnostic,
        messageText: withoutTheUnverifiableClaim(diagnostic, name),
        category: ts.DiagnosticCategory.Warning,
      }),
    ),
  );
}

/** `SWR4024`, the sentence about a macro name written on its own. */
const bareMacroNameCode = 4024;

/**
 * The sentence with its one unverifiable claim taken out of it.
 *
 * `SWR4024` says "nothing defines X in the emitted code", which is a claim
 * about the whole program: `lib.d.ts`, an ambient declaration and a `declare
 * global` all declare names expansion cannot see. On a checked path that claim
 * is earned, because it is only said where TypeScript has already reported it
 * cannot find the name, and the sentence replaces `Cannot find name` with an
 * explanation of it. Here nothing has said anything, so the claim is made with
 * nothing behind it -- the same over-reach the held-name design took out
 * everywhere else, left in the one place the design cannot hand the sentence
 * on.
 *
 * What is left is what expansion does know: the name is a macro here, and the
 * emitted code will contain it as written.
 */
function withoutTheUnverifiableClaim(
  diagnostic: ts.Diagnostic,
  name: string,
): ts.Diagnostic["messageText"] {
  const message = diagnostic.messageText;
  if (diagnostic.code !== bareMacroNameCode || typeof message !== "string")
    return message;
  const claim = `A macro is a compile-time name, so nothing defines ${name} in the emitted code.`;
  if (!message.includes(claim)) return message;
  return message.replace(
    claim,
    `A macro is a compile-time name, so ${name} is written into the emitted ` +
      `code as it stands, and nothing in this build checks this file for ` +
      `whether anything defines it there.`,
  );
}
