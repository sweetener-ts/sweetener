import type { SlashMisreadListener } from "@sweetener/enforestation";
import type { SlashReading, TokenSyntax } from "@sweetener/syntax";

/**
 * The slashes a macro rule's captures found read the other way from the
 * grammar, held until the invocation they were found in settles.
 *
 * A capture reads by a grammar -- `$body:stmt` reads a statement -- and where
 * its grammar begins an operand at a slash the reader judged a division, the
 * slash is a regular expression, as it is anywhere else that grammar is read:
 * `unless (c) /[(]/.test(s)`, which only reading the source again reads (see
 * `SlashMisreadListener`). But a rule is tried and may be abandoned for the
 * next one, and what one rule's capture found is no finding if another rule
 * reads the invocation. So what a capture finds waits on its invocation:
 *
 * - An invocation some rule reads keeps nothing its rules found while they
 *   were tried. The rule that read it read the slash as written.
 * - An invocation no rule reads keeps what the rules that came closest found,
 *   the same rules its failure is reported from.
 *
 * Kept findings wait on the invocation around this one in turn, and are told
 * to the listener once no invocation is open. Outside an invocation -- a
 * macro's extent measured while the syntax around it is read -- a capture's
 * findings are dropped, because the invocation that follows finds them again.
 */
export class CaptureSlashMisreads {
  readonly #listener: SlashMisreadListener | undefined;
  readonly #found: {
    readonly slash: TokenSyntax;
    readonly reading: SlashReading;
  }[] = [];
  #open = 0;

  constructor(listener: SlashMisreadListener | undefined) {
    this.#listener = listener;
  }

  /** The listener a capture is given. */
  readonly record: SlashMisreadListener = (slash, reading) => {
    if (this.#open > 0) this.#found.push({ slash, reading });
  };

  /** How many findings are held, which marks where the next ones begin. */
  position(): number {
    return this.#found.length;
  }

  /** Opens an invocation, answering where its findings begin. */
  open(): number {
    this.#open += 1;
    return this.#found.length;
  }

  /**
   * Settles the invocation opened at `start`: of what was found since, keeps
   * the findings in `kept`, each a range of positions, and the findings past
   * `through`, and drops the rest.
   */
  close(
    start: number,
    kept: readonly (readonly [number, number])[],
    through: number,
  ): void {
    if (this.#open === 0)
      throw new RangeError("No invocation is open to settle");
    const retained = [
      ...kept.flatMap(([from, to]) => this.#found.slice(from, to)),
      ...this.#found.slice(through),
    ];
    this.#found.length = start;
    this.#found.push(...retained);
    this.#open -= 1;
    if (this.#open > 0) return;
    for (const { slash, reading } of this.#found)
      this.#listener?.(slash, reading);
    this.#found.length = 0;
  }
}
