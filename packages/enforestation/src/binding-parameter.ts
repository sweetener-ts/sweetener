import type {
  Binding,
  BindingEnvironment,
  BindingKind,
  BindingVisibility,
  EnvironmentStore,
  Phase,
  SyntaxSpace,
} from "@sweetener/hygiene";
import type {
  DeclarationGroupId,
  ScopeSetId,
  SyntaxId,
} from "@sweetener/shared";
import {
  createProtectedSyntax,
  spanEnvelope,
  createSyntaxCursor,
  createSyntaxSequence,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCursor,
  type SyntaxSequence,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  createConsumerFailure,
  type ConsumerAttempt,
  type ConsumerContext,
  type MacroExtentResolver,
  type SyntaxConsumer,
} from "./consumer.js";

export type BindingShape = "identifier" | "array" | "object";

export type BindingPathSegment =
  | { readonly kind: "array-element"; readonly index: number }
  | { readonly kind: "object-property"; readonly property: string }
  | { readonly kind: "parameter"; readonly index: number }
  | { readonly kind: "rest" };

export interface BindingName {
  readonly spelling: string;
  readonly origin: TokenSyntax["origin"];
  readonly scopes: ScopeSetId;
  readonly syntax: TokenSyntax;
  readonly path: readonly BindingPathSegment[];
}

export interface BindingSkeleton {
  readonly syntax: ProtectedSyntax;
  readonly names: readonly BindingName[];
  readonly shape: BindingShape;
}

export interface BindingAttemptSuccess {
  readonly matched: true;
  readonly skeleton: BindingSkeleton;
  readonly cursor: SyntaxCursor;
}

export interface BindingAttemptFailure {
  readonly matched: false;
  readonly attempt: ConsumerAttempt;
}

export type BindingAttempt = BindingAttemptSuccess | BindingAttemptFailure;

export type BindingMacroResolver = (
  cursor: SyntaxCursor,
  context: ConsumerContext,
) => BindingAttempt | undefined;

export interface BindingConsumerOptions {
  readonly allocateSyntaxId: () => SyntaxId;
  readonly origins: OriginStore;
  readonly resolveMacro?: BindingMacroResolver | undefined;
}

export interface BindingConsumer extends SyntaxConsumer {
  consumeBinding(
    cursor: SyntaxCursor,
    context: ConsumerContext,
  ): BindingAttempt;
}

export interface ParameterSkeleton {
  readonly syntax: SyntaxSequence;
  readonly binding: BindingSkeleton | undefined;
  readonly thisParameter: boolean;
  readonly rest: boolean;
  readonly optional: boolean;
  readonly modifiers: readonly TokenSyntax[];
  readonly typeSyntax: SyntaxSequence;
  readonly initializerSyntax: SyntaxSequence;
}

export interface ParameterListSkeleton {
  readonly syntax: ProtectedSyntax;
  readonly parameters: readonly ParameterSkeleton[];
  readonly names: readonly BindingName[];
}

export interface ParameterListResult {
  readonly matched: true;
  readonly skeleton: ParameterListSkeleton;
  readonly cursor: SyntaxCursor;
}

export interface RegisterBindingSkeletonOptions {
  readonly store: EnvironmentStore;
  readonly environment: BindingEnvironment;
  readonly skeleton: BindingSkeleton;
  readonly phase: Phase;
  readonly space: SyntaxSpace;
  readonly kind: BindingKind;
  readonly declarationGroup?: DeclarationGroupId | undefined;
  readonly visibility?: BindingVisibility | undefined;
}

export interface RegisterBindingSkeletonResult {
  readonly environment: BindingEnvironment;
  readonly bindings: readonly Binding[];
}

const parameterModifiers = new Set([
  "const",
  "in",
  "out",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
]);

function token(
  syntax: Syntax | undefined,
  raw?: string,
): syntax is TokenSyntax {
  return syntax?.tag === "token" && (raw === undefined || syntax.raw === raw);
}

function identifier(syntax: Syntax | undefined): syntax is TokenSyntax {
  return token(syntax) && syntax.kind === "identifier";
}

function splitOnComma(syntax: readonly Syntax[]): readonly SyntaxSequence[] {
  const segments: Syntax[][] = [[]];
  for (const item of syntax) {
    if (token(item, ",")) segments.push([]);
    else segments.at(-1)!.push(item);
  }
  return Object.freeze(
    segments.map((segment) => createSyntaxSequence(segment)),
  );
}

function beforeToken(
  syntax: readonly Syntax[],
  spelling: string,
): readonly Syntax[] {
  const index = syntax.findIndex((item) => token(item, spelling));
  return index < 0 ? syntax : syntax.slice(0, index);
}

function propertySpelling(syntax: Syntax | undefined): string | undefined {
  if (token(syntax)) return syntax.raw;
  return syntax?.tag === "group" && syntax.delimiter === "bracket"
    ? "[computed]"
    : undefined;
}

interface ParsedPattern {
  readonly names: readonly BindingName[];
  readonly shape: BindingShape;
}

function parsePattern(
  syntax: Syntax,
  path: readonly BindingPathSegment[],
): ParsedPattern | undefined {
  if (identifier(syntax)) {
    return Object.freeze({
      shape: "identifier" as const,
      names: Object.freeze([
        Object.freeze({
          spelling: syntax.raw,
          origin: syntax.origin,
          scopes: syntax.scopes,
          syntax,
          path: Object.freeze([...path]),
        }),
      ]),
    });
  }
  if (syntax.tag !== "group") return undefined;
  if (syntax.delimiter === "bracket") {
    const names: BindingName[] = [];
    const segments = splitOnComma(syntax.children);
    for (const [index, segment] of segments.entries()) {
      if (segment.length === 0) continue;
      let offset = 0;
      const segmentPath: BindingPathSegment[] = [
        ...path,
        Object.freeze({ kind: "array-element" as const, index }),
      ];
      if (token(segment[offset], "...")) {
        if (
          index !== segments.length - 1 ||
          segment.some((item) => token(item, "="))
        )
          return undefined;
        segmentPath.push(Object.freeze({ kind: "rest" as const }));
        offset += 1;
      }
      const remainder = segment.slice(offset);
      const equals = remainder.findIndex((item) => token(item, "="));
      if (equals === remainder.length - 1) return undefined;
      const target = beforeToken(remainder, "=");
      if (target.length !== 1) return undefined;
      const parsed = parsePattern(target[0]!, segmentPath);
      if (parsed === undefined) return undefined;
      names.push(...parsed.names);
    }
    return Object.freeze({
      shape: "array" as const,
      names: Object.freeze(names),
    });
  }
  if (syntax.delimiter === "brace") {
    const names: BindingName[] = [];
    const segments = splitOnComma(syntax.children);
    for (const [index, segment] of segments.entries()) {
      if (segment.length === 0) {
        if (index < segments.length - 1) return undefined;
        continue;
      }
      let rest = false;
      let content: readonly Syntax[] = segment;
      if (token(content[0], "...")) {
        if (
          index !== segments.length - 1 ||
          content.some((item) => token(item, "="))
        )
          return undefined;
        rest = true;
        content = content.slice(1);
      }
      const colon = content.findIndex((item) => token(item, ":"));
      const property = propertySpelling(content[0]);
      if (property === undefined) return undefined;
      if (rest && colon >= 0) return undefined;
      const targetContent = colon < 0 ? content : content.slice(colon + 1);
      const equals = targetContent.findIndex((item) => token(item, "="));
      if (equals === targetContent.length - 1) return undefined;
      const target = beforeToken(targetContent, "=");
      if (target.length !== 1) return undefined;
      if (rest && !identifier(target[0])) return undefined;
      const targetPath: BindingPathSegment[] = [
        ...path,
        Object.freeze({ kind: "object-property" as const, property }),
      ];
      if (rest) targetPath.push(Object.freeze({ kind: "rest" as const }));
      const parsed = parsePattern(target[0]!, targetPath);
      if (parsed === undefined) return undefined;
      names.push(...parsed.names);
    }
    return Object.freeze({
      shape: "object" as const,
      names: Object.freeze(names),
    });
  }
  return undefined;
}

function originFor(origins: OriginStore, syntax: readonly Syntax[]) {
  const unique = [...new Set(syntax.map(({ origin }) => origin))];
  return unique.length === 1 ? unique[0]! : origins.composed(unique);
}

function protectBinding(
  options: BindingConsumerOptions,
  syntax: readonly Syntax[],
): ProtectedSyntax {
  const first = syntax[0]!;
  return createProtectedSyntax({
    id: options.allocateSyntaxId(),
    span: spanEnvelope(syntax.map(({ span }) => span)),
    origin: originFor(options.origins, syntax),
    scopes: first.scopes,
    category: "binding",
    children: syntax,
  });
}

function failed(cursor: SyntaxCursor, start: number): BindingAttemptFailure {
  return Object.freeze({
    matched: false,
    attempt: Object.freeze({
      matched: false,
      failure: createConsumerFailure({
        category: "binding",
        cursor: cursor.identity,
        progress: cursor.index - start,
        specificity: cursor.index === start ? 1 : 30,
        expectations: ["identifier, array pattern, or object pattern"],
      }),
    }),
  });
}

class StructuralBindingConsumer implements BindingConsumer {
  constructor(readonly options: BindingConsumerOptions) {
    Object.freeze(this);
  }

  consumeBinding(
    cursor: SyntaxCursor,
    context: ConsumerContext,
  ): BindingAttempt {
    const start = cursor.index;
    context.cancellation.throwIfCancellationRequested();
    context.tracker.chargeMatcherSteps();
    const macro = this.options.resolveMacro?.(cursor, context);
    if (macro !== undefined) return macro;
    const syntax = cursor.peek();
    if (syntax === undefined || context.stopSet.matches(cursor))
      return failed(cursor, start);
    // A binder that has already been enforested — one spliced in from a macro
    // whose replacement was parsed before it reached here — is taken as it
    // stands, with its names read back out of what it wraps.
    if (syntax.tag === "protected" && syntax.category === "binding") {
      const inner = syntax.children[0];
      const reparsed =
        syntax.children.length === 1 && inner !== undefined
          ? parsePattern(inner, Object.freeze([]))
          : undefined;
      cursor.advance();
      return Object.freeze({
        matched: true,
        skeleton: Object.freeze({
          syntax,
          names: reparsed?.names ?? Object.freeze([]),
          shape: reparsed?.shape ?? "identifier",
        }),
        cursor,
      });
    }
    const parsed = parsePattern(syntax, Object.freeze([]));
    if (parsed === undefined) return failed(cursor, start);
    cursor.advance();
    return Object.freeze({
      matched: true,
      skeleton: Object.freeze({
        syntax: protectBinding(this.options, [syntax]),
        names: parsed.names,
        shape: parsed.shape,
      }),
      cursor,
    });
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const result = this.consumeBinding(cursor, context);
    if (!result.matched) return result.attempt;
    return Object.freeze({
      matched: true,
      syntax: result.skeleton.syntax,
      cursor: result.cursor,
    });
  }
}

function parseParameter(
  segment: SyntaxSequence,
  index: number,
  consumer: BindingConsumer,
  context: ConsumerContext,
): ParameterSkeleton | undefined {
  if (segment.length === 0) return undefined;
  let offset = 0;
  const modifiers: TokenSyntax[] = [];
  while (true) {
    const modifier = segment[offset];
    if (!token(modifier) || !parameterModifiers.has(modifier.raw)) break;
    modifiers.push(modifier);
    offset += 1;
  }
  const rest = token(segment[offset], "...");
  if (rest) offset += 1;
  const thisParameter = token(segment[offset], "this");
  let bindingSkeleton: BindingSkeleton | undefined;
  if (thisParameter) {
    offset += 1;
  } else {
    const binding = consumer.consumeBinding(
      createSyntaxCursor(segment.slice(offset)),
      context,
    );
    if (!binding.matched) return undefined;
    offset += binding.cursor.index;
    bindingSkeleton = binding.skeleton;
  }
  const optional = token(segment[offset], "?");
  if (optional) offset += 1;
  let typeSyntax: readonly Syntax[] = [];
  if (token(segment[offset], ":")) {
    const start = ++offset;
    while (offset < segment.length && !token(segment[offset], "=")) offset += 1;
    typeSyntax = segment.slice(start, offset);
    if (typeSyntax.length === 0) return undefined;
  }
  let initializerSyntax: readonly Syntax[] = [];
  if (token(segment[offset], "=")) {
    initializerSyntax = segment.slice(offset + 1);
    if (initializerSyntax.length === 0) return undefined;
    offset = segment.length;
  }
  if (
    offset !== segment.length ||
    (rest && (optional || initializerSyntax.length > 0)) ||
    (optional && initializerSyntax.length > 0) ||
    (thisParameter &&
      (rest || optional || modifiers.length > 0 || typeSyntax.length === 0))
  ) {
    return undefined;
  }
  const names = (bindingSkeleton?.names ?? []).map((name) =>
    Object.freeze({
      ...name,
      path: Object.freeze([
        Object.freeze({ kind: "parameter" as const, index }),
        ...name.path,
      ]),
    }),
  );
  return Object.freeze({
    syntax: segment,
    binding:
      bindingSkeleton === undefined
        ? undefined
        : Object.freeze({
            ...bindingSkeleton,
            names: Object.freeze(names),
          }),
    thisParameter,
    rest,
    optional,
    modifiers: Object.freeze(modifiers),
    typeSyntax: createSyntaxSequence(typeSyntax),
    initializerSyntax: createSyntaxSequence(initializerSyntax),
  });
}

/**
 * Adapts the shared macro extent resolver to binder position. A macro's
 * invocation is preserved as one binding extent and expanded later, so the
 * names it introduces are the ones its expansion parses out, not any this
 * skeleton could report now.
 */
export function bindingMacroResolver(
  resolve: MacroExtentResolver,
): BindingMacroResolver {
  return (cursor, context) => {
    const attempted = resolve("binding", cursor, context);
    if (attempted === undefined || !attempted.matched) return undefined;
    // A macro is measured on a fork and answers with that fork; every other
    // reading answers with the cursor it was given, advanced. A caller that
    // reads on from the cursor it passed down would otherwise stand at the
    // invocation still and read it a second time.
    if (attempted.cursor !== cursor) {
      if (attempted.cursor.index < cursor.index) {
        throw new TypeError(
          "Macro binding resolver returned an extent behind the cursor",
        );
      }
      cursor.advance(attempted.cursor.index - cursor.index);
    }
    return Object.freeze({
      matched: true,
      skeleton: Object.freeze({
        syntax: attempted.syntax,
        names: Object.freeze([]),
        shape: "identifier" as BindingShape,
      }),
      cursor,
    });
  };
}

export function createBindingConsumer(
  options: BindingConsumerOptions,
): BindingConsumer {
  return Object.freeze(new StructuralBindingConsumer(options));
}

export function consumeParameterList(
  cursor: SyntaxCursor,
  context: ConsumerContext,
  options: BindingConsumerOptions,
): ParameterListResult | undefined {
  const group = cursor.peek();
  if (group?.tag !== "group" || group.delimiter !== "parenthesis")
    return undefined;
  const bindingConsumer = createBindingConsumer(options);
  const parameters: ParameterSkeleton[] = [];
  const segments = splitOnComma(group.children);
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      if (group.children.length > 0 && index !== segments.length - 1)
        return undefined;
      continue;
    }
    const parameter = parseParameter(segment, index, bindingConsumer, context);
    if (parameter === undefined) return undefined;
    if (parameter.rest && index !== segments.length - 1) return undefined;
    parameters.push(parameter);
  }
  cursor.advance();
  const names = parameters.flatMap(({ binding }) => binding?.names ?? []);
  return Object.freeze({
    matched: true,
    skeleton: Object.freeze({
      syntax: createProtectedSyntax({
        id: options.allocateSyntaxId(),
        span: group.span,
        origin: group.origin,
        scopes: group.scopes,
        category: "binding",
        children: [group],
      }),
      parameters: Object.freeze(parameters),
      names: Object.freeze(names),
    }),
    cursor,
  });
}

export function registerBindingSkeleton(
  options: RegisterBindingSkeletonOptions,
): RegisterBindingSkeletonResult {
  let environment = options.environment;
  const bindings: Binding[] = [];
  const declarationGroup =
    options.declarationGroup ?? options.store.freshDeclarationGroup();
  for (const name of options.skeleton.names) {
    const declared = options.store.declare(environment, {
      spelling: name.spelling,
      scopes: name.scopes,
      phase: options.phase,
      space: options.space,
      declaration: name.origin,
      kind: options.kind,
      declarationGroup,
      visibility: options.visibility,
    });
    environment = declared.environment;
    bindings.push(declared.binding);
  }
  return Object.freeze({
    environment,
    bindings: Object.freeze(bindings),
  });
}
