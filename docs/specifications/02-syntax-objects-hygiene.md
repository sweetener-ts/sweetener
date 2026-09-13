# Syntax Objects and Hygiene Specification

## 1. Syntax representation

```ts
type Syntax = TokenSyntax | GroupSyntax | ProtectedSyntax | RootSyntax;

interface SyntaxBase {
  id: SyntaxId;
  span: Span;
  origin: OriginId;
  scopes: ScopeSetId;
}

interface TokenSyntax extends SyntaxBase {
  tag: "token";
  kind: TokenKind;
  raw: string;
  value: string | number | undefined;
  leadingTrivia: readonly Trivia[];
  trailingTrivia: readonly Trivia[];
  lexicalMode: LexicalMode;
}

interface GroupSyntax extends SyntaxBase {
  tag: "group";
  delimiter: DelimiterKind;
  open: TokenSyntax;
  children: readonly Syntax[];
  close: TokenSyntax | MissingToken;
}

interface ProtectedSyntax extends SyntaxBase {
  tag: "protected";
  category: SyntaxCategory;
  precedence: Precedence | undefined;
  children: readonly Syntax[];
}

interface RootSyntax extends SyntaxBase {
  tag: "root";
  children: readonly Syntax[];
}
```

`RootSyntax` represents one complete source file without inventing delimiter
tokens that do not occur in the source. Its children include the EOF token so
final trivia remains lossless.

`ProtectedSyntax` records a consumed grammatical unit. It does not contain a
TypeScript AST. Templates preserve the node as one semantic unit and the printer
adds grouping when its output context requires it.

## 2. Identity and equality

- `SyntaxId` identifies a node instance within one compiler session.
- Structural hashes support caches and progress checks.
- Syntax equality compares structure, raw token data, scopes, and origins.
- Matcher literal equality ignores trivia and source position.
- Identifier binding equality compares `BindingId`, not spelling or printed name.

Incremental reading SHOULD reuse IDs for unchanged green subtrees. Correctness
must not depend on reuse.

## 3. Origins

```ts
type Origin =
  | { kind: "source"; sourceId: SourceId; span: Span }
  | { kind: "copied"; capture: CaptureId; parent: OriginId }
  | { kind: "introduced"; definition: OriginId; invocation: OriginId }
  | { kind: "synthesized"; invocation: OriginId; reason: SynthesisReason }
  | { kind: "composed"; parts: readonly OriginId[] };
```

Origin chains form a directed acyclic graph. The compiler interns origin nodes
and rejects cycles as internal errors. Diagnostics choose a primary origin by
stage-specific policy and retain other origins as related locations.

## 4. Scope sets

`ScopeId` is a fresh opaque integer. `ScopeSetId` refers to an interned sorted set
or persistent bitset. The implementation exposes these operations:

```ts
interface ScopeStore {
  empty(): ScopeSetId;
  add(set: ScopeSetId, scope: ScopeId): ScopeSetId;
  remove(set: ScopeSetId, scope: ScopeId): ScopeSetId;
  union(left: ScopeSetId, right: ScopeSetId): ScopeSetId;
  subset(left: ScopeSetId, right: ScopeSetId): boolean;
  size(set: ScopeSetId): number;
}
```

Callers cannot enumerate scopes outside debug and trace code.

## 5. Bindings and spaces

```ts
interface Binding {
  id: BindingId;
  spelling: string;
  scopes: ScopeSetId;
  phase: Phase;
  space: SyntaxSpace;
  declaration: OriginId;
  kind: BindingKind;
}

type SyntaxSpace =
  | "value"
  | "type"
  | "namespace"
  | "label"
  | "syntax-item"
  | "syntax-stmt"
  | "syntax-expr"
  | "syntax-type"
  | "syntax-binding"
  | "syntax-class-element"
  | "syntax-jsx-child";
```

TypeScript permits one declaration to create bindings in several spaces. The
hygiene package records separate binding entries that share an optional
`DeclarationGroupId`.

## 6. Resolution algorithm

Given identifier `i`, environment `E`, phase `p`, and space `s`:

1. Select bindings in `E` whose spelling equals `i.value`, phase equals `p`, and
   space equals `s`.
2. Keep candidates whose scope set is a subset of `i.scopes`.
3. Remove each candidate whose scope set is a strict subset of another remaining
   candidate's scope set.
4. Return the sole maximal candidate.
5. Return `unbound` when no candidate remains.
6. Return `ambiguous` with all maximal candidates when several remain.

Environment lexical position filters candidates before this algorithm. A binding
outside its declaration region cannot participate even if scopes match.

A macro's name is not reserved. Racket resolves an identifier and only then asks
whether the binding it found denotes a transformer, so an ordinary binding
shadows a macro rather than sitting in a space where the two never compete:
`(let ([or 5]) or)` is `5`, and shadowing reaches core forms. Rhombus states the
same of its expression space -- a binding there "hides any binding for another
space in an enclosing scope".

Macro resolution here is a module-table lookup rather than a walk of this
algorithm, so the equivalent rule is applied separately: the expander records
what each region of source binds, and a macro is not dispatched for a spelling
an enclosing region binds. Value and type are kept apart, because TypeScript
keeps them apart -- `const list` and `type list` are both legal, and neither
shadows the other's macro. That is the one point where this cannot follow
Rhombus, whose expression space hides every other space.

Resolution MUST produce the same result regardless of insertion order.

## 7. Macro invocation scopes

For one macro invocation:

1. Allocate introduction scope `I`.
2. Allocate use-site scope `U`.
3. Add `U` and `I` to input passed through a transformer boundary.
4. Flip `I` on transformer output. Copied input loses `I`; constructed syntax
   gains `I`.
5. Retain `U` on copied captures. Constructed syntax does not receive `U`.
6. Give declarative template syntax its definition scopes plus `I`.
7. Add lexical binding scopes to generated declarations and their regions after
   the invocation transform.

Declarative instantiation can apply the equivalent direct rule: add `U` to
captures and add `I` to definition-site template syntax. ADR-0006 records the
model and its executable local-macro and generated-definition examples.

## 8. Binding contracts

A macro rule can declare relationships between captures:

```ts
binds $step.name
  in $rest
  space value
  kind lexical
```

The compiler validates:

- the binder capture has class `binding` or a class with binding fields;
- the region capture exists at a compatible repetition depth;
- the contract does not place one binding into unrelated repetition elements;
- the named space fits the macro expansion category;
- alternatives return the fields referenced by the contract.

During matching, the expander allocates a lexical scope `L`, adds `L` to the
binder and region, registers the binding, then expands the region. Sequential
forms such as `do` can nest one binding contract per recursive step.

## 9. Template binding recognition

The expander recognizes bindings created through built-in TypeScript forms in
templates, including:

- variable and function declarations;
- parameters and type parameters;
- class, interface, type alias, enum, namespace, and import declarations;
- catch bindings;
- destructuring patterns;
- labels.

The binding walker operates on protected syntax or a small binding skeleton
produced by syntax consumers. It MUST NOT resolve scope through printed text.

## 10. Explicit hygiene operations

```text
#fresh("hint")
#callsite($identifier)
#definition($identifier)
#capture($identifier)
#text($syntax)
#join($identifier, prefix: "set", casing: "upper-first")
```

- `#fresh` creates a new identifier with a fresh binding identity and template
  origin.
- `#callsite` gives an identifier the invocation's lexical scopes.
- `#definition` uses the macro definition's lexical scopes.
- `#capture` removes the introduction barrier required to bind or reference
  call-site syntax. The compiler emits a trace event and optional warning.
- `#text` returns stable raw token text for an accepted token or group. It does
  not expose scope IDs or generated printer names.
- `#join` constructs one identifier from an identifier capture plus optional
  `prefix`, `suffix`, and `casing` options. `casing` is one of `preserve`,
  `upper-first`, `lower-first`, `upper`, or `lower`. Definition-time validation
  restricts the capture to identifier syntax classes, and expansion rejects a
  result that is not a valid ECMAScript identifier.

A constructed identifier can be declared by a binding contract:

```text
bind #join($name, prefix: "set", casing: "upper-first") in following as lexical value;
```

This is a generated binding, not a textual convention. The contract derives
the spelling, allocates its lexical scope, declares it in the hygiene
environment, attaches that scope to matching `#join` output, and exports the
scope to following syntax. The source capture is not rebound by this contract.

These operations validate argument classes at macro-definition time.

Evaluation retains an explicit operation piece until template instantiation so
scope and origin allocation occur in one place. Each operation records its
source origin, selected capture when applicable, enclosing repetition indices,
and a safe detail such as a fresh hint, stable text, or index. Trace records do
not expose scope-set contents.

## 11. Printed names

The printer maps each `BindingId` to a name. It prefers the declaration spelling,
then adds a deterministic suffix when two visible bindings would collide after
hygiene erasure. The suffix derives from traversal order in the expanded file,
not process-global counters.

Property names, string values, and labels follow their own TypeScript semantics.
The printer renames shorthand properties into explicit properties when the
binding name and property spelling diverge.

## 12. Invariants

- A template-introduced binding cannot capture a call-site identifier without
  `#capture` or a binding contract.
- A captured identifier keeps its resolved call-site binding after substitution.
- Renaming an unrelated source binding cannot change expansion structure.
- Printing cannot change binding identity.
- Cache serialization preserves scope, binding, and origin identities through
  stable remapping.
- Macro phase bindings cannot resolve as runtime value bindings.

## 13. Required semantic examples

The conformance suite must trace:

1. a generated temporary next to a call-site variable with the same spelling;
2. `do` bindings nested across three clauses;
3. a `match` branch binding that does not escape its branch;
4. a macro definition generated from a captured name;
5. a definition-site helper reference shadowed at the call site;
6. an explicit capture operation;
7. an ambiguous scope-set resolution error;
8. value and type bindings with the same spelling.
