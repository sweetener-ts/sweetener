/**
 * When a sentence expansion holds about a name answers what TypeScript said.
 *
 * Expansion holds a sentence about a name it left standing -- a macro written
 * where it is not read, a macro name on its own -- for whichever side can say
 * whether the name means anything. TypeScript is that side, and where it says
 * it cannot find the name, the held sentence is the better answer: it names
 * the macro rather than restating the question. `check` and the language
 * service both decide this here, so an editor and the command line say the
 * same thing about the same name.
 */

/**
 * What TypeScript says when it cannot find a value for a name. A macro written
 * outside the space it was declared for is emitted verbatim, so this is where
 * it surfaces.
 */
const unresolvedNameCodes: ReadonlySet<number> = new Set([
  2304, // Cannot find name 'X'.
  2552, // Cannot find name 'X'. Did you mean 'Y'?
  // The same, with advice for a name TypeScript knows a package or a library
  // for. The advice is wrong when the name is a macro's, and following it
  // makes the name resolve to that package's global instead.
  2580, // ... install type definitions for node?
  2581, // ... install type definitions for jQuery?
  2582, // ... install type definitions for a test runner?
  2583, // ... change your target library? ... '{1}' or later.
  2584, // ... change your target library? ... include 'dom'.
  2591, // ... for node? ... add 'node' to the types field.
  2592, // ... for jQuery? ... add 'jquery' to the types field.
  2593, // ... for a test runner? ... add 'jest' or 'mocha' to the types field.
  // The same, where a class declares a member of the name.
  2662, // ... Did you mean the static member 'C.X'?
  2663, // ... Did you mean the instance member 'this.X'?
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

/**
 * Whether a held sentence with code `explanationCode` answers what TypeScript
 * said with code `typescriptCode`.
 */
export function heldSentenceAnswers(
  typescriptCode: number,
  explanationCode: number | undefined,
): boolean {
  return (
    unresolvedNameCodes.has(typescriptCode) ||
    (explanationCode === wrongCategoryMacroCode &&
      resolvedInAnotherSpaceCodes.has(typescriptCode))
  );
}

/**
 * The name TypeScript's sentence is about, where it is one a held sentence
 * can answer.
 *
 * Read out of the message rather than out of the source, because the span has
 * been mapped back to the invocation that wrote the name and the text there is
 * the macro call, not the name. Every message these codes carry names the
 * identifier first and in quotes.
 */
export function nameTypeScriptNamed(
  typescriptCode: number,
  messageText: string,
): string | undefined {
  if (
    !unresolvedNameCodes.has(typescriptCode) &&
    !resolvedInAnotherSpaceCodes.has(typescriptCode)
  )
    return undefined;
  return /'([^']+)'/u.exec(messageText)?.[1];
}
