import {
  capturedInvocationScopes,
  introducedTemplateScopes,
  type GeneratedContractBinding,
  type InvocationScopes,
  type ScopeStore,
} from "@sweetener/hygiene";
import {
  createResourceBudget,
  neverCancelled,
  ResourceTracker,
  type BindingId,
  type CancellationToken,
  type CaptureId,
  type OriginId,
  type ResourceBudget,
  type ScopeSetId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
  createProtectedSyntax,
  createRootSyntax,
  createSyntaxSequence,
  createToken,
  createTrivia,
  delimiterText,
  type GroupSyntax,
  type OriginStore,
  type Span,
  type Syntax,
  type SyntaxSequence,
  type TokenKind,
  type TokenSyntax,
  type Trivia,
} from "@sweetener/syntax";
import type {
  EvaluatedGroup,
  EvaluatedOperation,
  EvaluatedSyntax,
  EvaluatedTemplate,
} from "./evaluator.js";

export interface FreshBinding {
  readonly binding: BindingId;
  readonly syntax: SyntaxId;
  readonly hint: string;
  readonly ordinal: number;
  readonly origin: OriginId;
}

export interface InstantiateTemplateOptions {
  readonly scopeStore: ScopeStore;
  readonly origins: OriginStore;
  readonly invocationScopes: InvocationScopes;
  readonly invocationOrigin: OriginId;
  readonly definitionScopes: ScopeSetId;
  readonly callsiteScopes: ScopeSetId;
  readonly anchor: Span;
  readonly allocateSyntaxId: () => SyntaxId;
  readonly allocateBindingId: () => BindingId;
  readonly budget?: Partial<ResourceBudget> | undefined;
  readonly tracker?: ResourceTracker | undefined;
  readonly cancellation?: CancellationToken | undefined;
  readonly generatedBindings?: readonly GeneratedContractBinding[] | undefined;
}

export interface InstantiateTemplateResult {
  readonly syntax: SyntaxSequence;
  readonly freshBindings: readonly FreshBinding[];
  readonly outputOrigins: readonly OriginId[];
  readonly outputTokens: number;
}

type ClonePolicy =
  | { readonly kind: "template" }
  | { readonly kind: "capture"; readonly capture: CaptureId }
  | {
      readonly kind: "operation";
      readonly capture: CaptureId;
      readonly operationOrigin: OriginId;
      readonly scopes: ScopeSetId;
    };

class Instantiator {
  readonly #options: InstantiateTemplateOptions;
  readonly #tracker: ResourceTracker;
  readonly #cancellation: CancellationToken;
  readonly #freshBindings: FreshBinding[] = [];
  readonly #outputOrigins: OriginId[] = [];

  constructor(options: InstantiateTemplateOptions) {
    this.#options = options;
    this.#tracker =
      options.tracker ??
      new ResourceTracker(createResourceBudget(options.budget ?? {}));
    this.#cancellation = options.cancellation ?? neverCancelled;
    if (!options.origins.has(options.invocationOrigin)) {
      throw new RangeError("Invocation origin is absent from the origin store");
    }
  }

  instantiate(output: readonly EvaluatedTemplate[]): InstantiateTemplateResult {
    const pieces = this.#pieces(output);
    // The whitespace before a template's first token is the macro definition's
    // own indentation, not part of the program. Carried to the call site it can
    // change what the code means — a line break after `return` ends the
    // statement — so the invocation's own spacing stands instead.
    const syntax = createSyntaxSequence(
      pieces[0] === undefined
        ? pieces
        : [this.#clearLeadingTrivia(pieces[0]), ...pieces.slice(1)],
    );
    return Object.freeze({
      syntax,
      freshBindings: Object.freeze([...this.#freshBindings]),
      outputOrigins: Object.freeze([...this.#outputOrigins]),
      outputTokens: this.#tracker.usage.outputTokens,
    });
  }

  #pieces(output: readonly EvaluatedTemplate[]): Syntax[] {
    const syntax: Syntax[] = [];
    for (const piece of output) {
      this.#cancellation.throwIfCancellationRequested();
      if (piece.kind === "syntax") {
        syntax.push(...this.#syntaxPiece(piece));
      } else if (piece.kind === "group") {
        syntax.push(this.#groupPiece(piece));
      } else {
        syntax.push(...this.#operationPiece(piece));
      }
    }
    return syntax;
  }

  #syntaxPiece(piece: EvaluatedSyntax): Syntax[] {
    if (piece.source === "capture" && piece.capture === undefined) {
      throw new TypeError("Captured evaluated syntax requires a capture ID");
    }
    const policy: ClonePolicy =
      piece.source === "template"
        ? { kind: "template" }
        : { kind: "capture", capture: piece.capture! };
    const cloned = piece.syntax.map((syntax) => this.#clone(syntax, policy));
    // A placeholder carries the template's own layout -- the space in
    // `[$value, $value]` is trivia on the second `$value` -- and substitution
    // throws the placeholder away. Handing that layout to the syntax that took
    // its place is what makes the expansion read the way the template was
    // written. Syntax that arrived with layout of its own keeps it: that came
    // from the call site, which is the author's spelling of this very text and
    // so outranks the template's.
    const head = cloned[0];
    return head === undefined || piece.templateLeadingTrivia.length === 0
      ? cloned
      : [
          this.#defaultLeadingTrivia(head, piece.templateLeadingTrivia),
          ...cloned.slice(1),
        ];
  }

  #groupPiece(piece: EvaluatedGroup): GroupSyntax {
    return this.#nested(() => {
      const origin = this.#introduced(piece.origin);
      const scopes = this.#introducedScopes(
        piece.scopes ?? this.#options.definitionScopes,
      );
      const children = this.#pieces(piece.body);
      const open =
        piece.open === undefined
          ? this.#delimiterToken(piece.delimiter, true, origin, scopes)
          : (this.#clone(piece.open, { kind: "template" }) as TokenSyntax);
      const close =
        piece.close?.tag === "token"
          ? (this.#clone(piece.close, { kind: "template" }) as TokenSyntax)
          : this.#delimiterToken(piece.delimiter, false, origin, scopes);
      this.#step();
      const group = createGroup({
        id: this.#options.allocateSyntaxId(),
        span: this.#options.anchor,
        origin,
        scopes,
        delimiter: piece.delimiter,
        open,
        children,
        close,
      });
      this.#recordOrigin(group.origin);
      return group;
    });
  }

  #operationPiece(piece: EvaluatedOperation): Syntax[] {
    switch (piece.operation) {
      case "fresh": {
        const origin = this.#options.origins.synthesized(
          this.#options.invocationOrigin,
          "generated-binding",
        );
        // A scope of its own, so two `#fresh` of the same hint in one
        // expansion are two bindings. Sharing the invocation's scopes made
        // them one, and a template asking for two temporaries emitted the same
        // name twice — which TypeScript then rejected as a redeclaration.
        const scopes = this.#options.scopeStore.add(
          this.#introducedScopes(this.#options.definitionScopes),
          this.#options.scopeStore.freshScope(
            "lexical",
            `fresh:${piece.hint}:${String(piece.ordinal)}`,
          ),
        );
        const token = this.#generatedToken(
          "identifier",
          piece.hint,
          piece.hint,
          origin,
          scopes,
          piece.prototype,
        );
        this.#freshBindings.push(
          Object.freeze({
            binding: this.#options.allocateBindingId(),
            syntax: token.id,
            hint: piece.hint,
            ordinal: piece.ordinal,
            origin,
          }),
        );
        return [token];
      }
      case "metavar": {
        const origin = this.#introduced(piece.origin);
        const raw = `$${piece.hint}_${piece.indices.join("_")}`;
        return [
          this.#generatedToken(
            "identifier",
            raw,
            raw,
            origin,
            this.#introducedScopes(this.#options.definitionScopes),
            piece.prototype,
          ),
        ];
      }
      case "text": {
        const origin = this.#introduced(piece.origin);
        return [
          this.#generatedToken(
            "string-literal",
            JSON.stringify(piece.text),
            piece.text,
            origin,
            this.#introducedScopes(this.#options.definitionScopes),
            piece.prototype,
          ),
        ];
      }
      case "join": {
        const origin = this.#introduced(piece.origin);
        const matches = (this.#options.generatedBindings ?? []).filter(
          (binding) =>
            binding.spelling === piece.text &&
            binding.origin === piece.sourceOrigin,
        );
        if (matches.length > 1) {
          throw new TypeError(
            `Generated identifier ${piece.text} has ambiguous binding contracts`,
          );
        }
        const scopes =
          matches[0] === undefined
            ? this.#introducedScopes(this.#options.definitionScopes)
            : capturedInvocationScopes(
                this.#options.scopeStore,
                matches[0].scopes,
                this.#options.invocationScopes,
              );
        return [
          this.#generatedToken(
            "identifier",
            piece.text,
            piece.text,
            origin,
            scopes,
            piece.prototype,
          ),
        ];
      }
      case "index":
      case "count": {
        const origin = this.#introduced(piece.origin);
        return [
          this.#generatedToken(
            "numeric-literal",
            String(piece.value),
            piece.value,
            origin,
            this.#introducedScopes(this.#options.definitionScopes),
            piece.prototype,
          ),
        ];
      }
      case "callsite":
      case "definition":
      case "capture":
      case "trim": {
        const operationOrigin = this.#introduced(piece.origin);
        const captured = capturedInvocationScopes(
          this.#options.scopeStore,
          this.#options.callsiteScopes,
          this.#options.invocationScopes,
        );
        const scopes =
          piece.operation === "definition"
            ? this.#introducedScopes(this.#options.definitionScopes)
            : piece.operation === "capture"
              ? this.#options.scopeStore.add(
                  captured,
                  this.#options.invocationScopes.introduction,
                )
              : captured;
        const syntax = piece.syntax.map((syntax) =>
          this.#clone(syntax, {
            kind: "operation",
            operationOrigin,
            capture: piece.capture,
            scopes,
          }),
        );
        return piece.operation === "trim" && syntax[0] !== undefined
          ? [this.#trimLeadingTrivia(syntax[0]), ...syntax.slice(1)]
          : syntax;
      }
    }
  }

  /**
   * Drops the whitespace before a replacement entirely, rather than reducing it
   * to a space, so the invocation's own leading trivia can take its place.
   */
  #clearLeadingTrivia(syntax: Syntax): Syntax {
    switch (syntax.tag) {
      case "token":
        return createToken({ ...syntax, leadingTrivia: [] });
      case "group":
        return createGroup({
          ...syntax,
          open: this.#clearLeadingTrivia(syntax.open) as TokenSyntax,
        });
      case "protected": {
        const head = syntax.children[0];
        return head === undefined
          ? syntax
          : createProtectedSyntax({
              ...syntax,
              children: [
                this.#clearLeadingTrivia(head),
                ...syntax.children.slice(1),
              ],
            });
      }
      default:
        return syntax;
    }
  }

  /**
   * Gives the first token layout it does not already have, leaving syntax that
   * brought its own untouched.
   *
   * Trivia is not the only way syntax carries its own spacing: the whitespace
   * between JSX children is text, so a captured child begins with a `jsx-text`
   * token that already holds the newline the author wrote. Reading only the
   * trivia there put the template's space in front of that newline and printed
   * a line ending in one.
   */
  #defaultLeadingTrivia(syntax: Syntax, trivia: readonly Trivia[]): Syntax {
    switch (syntax.tag) {
      case "token":
        return syntax.leadingTrivia.length > 0 || /^\s/u.test(syntax.raw)
          ? syntax
          : createToken({ ...syntax, leadingTrivia: trivia });
      case "group":
        return createGroup({
          ...syntax,
          open: this.#defaultLeadingTrivia(syntax.open, trivia) as TokenSyntax,
        });
      case "protected":
      case "root": {
        const head = syntax.children[0];
        if (head === undefined) return syntax;
        const children = [
          this.#defaultLeadingTrivia(head, trivia),
          ...syntax.children.slice(1),
        ];
        return syntax.tag === "protected"
          ? createProtectedSyntax({ ...syntax, children })
          : createRootSyntax({ ...syntax, children });
      }
      default:
        return syntax;
    }
  }

  #trimLeadingTrivia(syntax: Syntax): Syntax {
    switch (syntax.tag) {
      case "token":
        return createToken({
          ...syntax,
          leadingTrivia: [
            createTrivia({
              kind: "whitespace",
              raw: " ",
              span: { start: syntax.span.start, end: syntax.span.start },
            }),
          ],
        });
      case "group":
        return createGroup({
          ...syntax,
          open: this.#trimLeadingTrivia(syntax.open) as TokenSyntax,
        });
      case "protected": {
        const first = syntax.children[0];
        return first === undefined
          ? syntax
          : createProtectedSyntax({
              ...syntax,
              children: [
                this.#trimLeadingTrivia(first),
                ...syntax.children.slice(1),
              ],
            });
      }
      case "root": {
        const first = syntax.children[0];
        return first === undefined
          ? syntax
          : createRootSyntax({
              ...syntax,
              children: [
                this.#trimLeadingTrivia(first),
                ...syntax.children.slice(1),
              ],
            });
      }
    }
  }

  #clone(syntax: Syntax, policy: ClonePolicy): Syntax {
    return this.#nested(() => {
      this.#step();
      const origin = this.#origin(syntax.origin, policy);
      const scopes = this.#scopes(syntax.scopes, policy);
      const span =
        policy.kind === "capture" ? syntax.span : this.#options.anchor;
      let cloned: Syntax;
      switch (syntax.tag) {
        case "token":
          this.#tracker.chargeOutputTokens();
          cloned = createToken({
            id: this.#options.allocateSyntaxId(),
            span,
            origin,
            scopes,
            kind: syntax.kind,
            raw: syntax.raw,
            value: syntax.value,
            leadingTrivia: syntax.leadingTrivia,
            trailingTrivia: syntax.trailingTrivia,
            lexicalMode: syntax.lexicalMode,
          });
          break;
        case "group": {
          const open = this.#clone(syntax.open, policy) as TokenSyntax;
          const children = syntax.children.map((child) =>
            this.#clone(child, policy),
          );
          const close =
            syntax.close.tag === "token"
              ? (this.#clone(syntax.close, policy) as TokenSyntax)
              : this.#delimiterToken(syntax.delimiter, false, origin, scopes);
          cloned = createGroup({
            id: this.#options.allocateSyntaxId(),
            span,
            origin,
            scopes,
            delimiter: syntax.delimiter,
            open,
            children,
            close,
          });
          break;
        }
        case "protected":
          cloned = createProtectedSyntax({
            id: this.#options.allocateSyntaxId(),
            span,
            origin,
            scopes,
            category: syntax.category,
            precedence: syntax.precedence,
            children: syntax.children.map((child) =>
              this.#clone(child, policy),
            ),
          });
          break;
        case "root":
          cloned = createRootSyntax({
            id: this.#options.allocateSyntaxId(),
            span,
            origin,
            scopes,
            children: syntax.children.map((child) =>
              this.#clone(child, policy),
            ),
          });
          break;
      }
      this.#recordOrigin(cloned.origin);
      return cloned;
    });
  }

  #origin(origin: OriginId, policy: ClonePolicy): OriginId {
    if (policy.kind === "template") return this.#introduced(origin);
    const copied = this.#options.origins.copied(policy.capture, origin);
    return policy.kind === "operation"
      ? this.#options.origins.composed([policy.operationOrigin, copied])
      : copied;
  }

  #scopes(scopes: ScopeSetId, policy: ClonePolicy): ScopeSetId {
    if (policy.kind === "template") return this.#introducedScopes(scopes);
    if (policy.kind === "operation") return policy.scopes;
    return capturedInvocationScopes(
      this.#options.scopeStore,
      scopes,
      this.#options.invocationScopes,
    );
  }

  #introduced(origin: OriginId): OriginId {
    return this.#options.origins.introduced(
      origin,
      this.#options.invocationOrigin,
    );
  }

  #introducedScopes(scopes: ScopeSetId): ScopeSetId {
    return introducedTemplateScopes(
      this.#options.scopeStore,
      scopes,
      this.#options.invocationScopes,
    );
  }

  #delimiterToken(
    delimiter: GroupSyntax["delimiter"],
    open: boolean,
    origin: OriginId,
    scopes: ScopeSetId,
  ): TokenSyntax {
    const text = delimiterText[delimiter];
    const kind: TokenKind =
      delimiter === "template"
        ? open
          ? "template-head"
          : "template-tail"
        : "punctuation";
    return this.#generatedToken(
      kind,
      open ? text.open : text.close,
      undefined,
      origin,
      scopes,
    );
  }

  #generatedToken(
    kind: TokenKind,
    raw: string,
    value: string | number | undefined,
    origin: OriginId,
    scopes: ScopeSetId,
    prototype?: TokenSyntax | undefined,
  ): TokenSyntax {
    this.#step();
    this.#tracker.chargeOutputTokens();
    const token = createToken({
      id: this.#options.allocateSyntaxId(),
      span: this.#options.anchor,
      origin,
      scopes,
      kind,
      raw,
      value,
      ...(prototype === undefined
        ? {}
        : {
            leadingTrivia: prototype.leadingTrivia,
            trailingTrivia: prototype.trailingTrivia,
          }),
    });
    this.#recordOrigin(origin);
    return token;
  }

  #recordOrigin(origin: OriginId): void {
    this.#outputOrigins.push(origin);
  }

  #nested<T>(operation: () => T): T {
    this.#tracker.enterNesting();
    try {
      return operation();
    } finally {
      this.#tracker.leaveNesting();
    }
  }

  #step(): void {
    this.#cancellation.throwIfCancellationRequested();
    this.#tracker.chargeExpansionSteps();
  }
}

export function instantiateTemplate(
  output: readonly EvaluatedTemplate[],
  options: InstantiateTemplateOptions,
): InstantiateTemplateResult {
  return new Instantiator(options).instantiate(output);
}
