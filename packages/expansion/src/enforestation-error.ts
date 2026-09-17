import type { SyntaxCategory } from "@sweetener/syntax";

/**
 * A macro's expansion did not enforest into one node of its category.
 *
 * This is something a macro author wrote, not a broken invariant: a template
 * that produces two statements where one expression was asked for, or JSX in a
 * file whose extension cannot hold it. It has its own class so it is reported
 * as a diagnostic on the macro. As a bare `TypeError` the project command
 * would catch it as an internal fault -- the whole expansion abandoned, no
 * file produced, and a message naming neither the macro nor where it was
 * written.
 */
export class EnforestationError extends Error {
  readonly category: SyntaxCategory;
  readonly syntaxText: string;

  constructor(category: SyntaxCategory, syntaxText: string) {
    super(`expanded syntax is not one ${category}: ${syntaxText}`);
    this.name = "EnforestationError";
    this.category = category;
    this.syntaxText = syntaxText;
  }
}
