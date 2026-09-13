# Expansion and Enforestation Specification

## 1. Phases and environments

Runtime code uses phase 0. A macro transformer used at phase `p` exists at phase
`p + 1`. Macro modules can import definitions for syntax at the importing
module's next phase.

```ts
interface ExpansionEnvironment {
  parent: ExpansionEnvironment | undefined;
  epoch: number;
  bindings: PersistentBindingMap;
  operators: PersistentOperatorTable;
  definitionContext: DefinitionContextId;
}
```

Each binding key contains spelling, phase, and syntax space. Extending an
environment creates a new epoch. Matcher memoization includes the epoch because
local syntax definitions can change how a class consumes input.

## 2. Definition contexts

A definition context processes items in source order:

1. expand enough of the next item to identify its kind;
2. register macro definitions at the phase and lexical point specified by their
   declaration kind;
3. register runtime/type binding skeletons for hygiene;
4. emit runtime items or remove compile-time definitions;
5. continue with the extended environment.

Generated macro definitions re-enter the same process. A generated definition
becomes visible to following items after its template expansion completes and
passes validation.

Recursive macro declarations allocate their binding before compiling their rule
templates. Nonrecursive declarations allocate the binding after initializer
validation.

## 3. Expansion categories

```ts
type SyntaxCategory =
  | "item"
  | "stmt"
  | "expr"
  | "type"
  | "binding"
  | "classElement"
  | "typeMember"
  | "jsxChild"
  | "token"
  | "tt";
```

Macro lookup uses the syntax space paired with the requested category. The same
spelling may bind macros in different categories.

An interface body and an object type are read as `typeMember` runs, and a
member may be spelled like a macro without invoking one: `name: T` and
`name(...)` declare a member called `name`. A `typeMember` macro is therefore
dispatched only where the key of the member being read cannot be the name
itself — a bare name, or a name in front of a brace. Past the member's first
`:` the member's type is read the way a type is read anywhere else, so a `type`
macro in an annotation still applies. A name standing in a member position that
resolves to no `typeMember` macro but does resolve in another category is
reported rather than emitted verbatim, because a leftover name there becomes an
implicitly-typed member rather than a syntax error.

## 4. `expandOne` algorithm

```text
expandOne(cursor, category, context):
  charge expansion step
  check cancellation and depth
  head := inspect candidate head at cursor
  binding := resolve syntax binding(head, category, phase, environment)

  if binding exists:
    return invokeMacro(binding, cursor, category, context)

  return consumer(category).consumeBuiltin(cursor, context)
```

Core-form shadowing changes lookup priority for a binding marked `shadows core`.
Without that marker, reserved built-in forms dispatch before ordinary macro
bindings. Punctuation operators use the operator table rather than core-form
dispatch.

`#core(...)` suppresses macro dispatch only for the first syntactic head in its
body (after item prefixes such as `export`). It does not make the resulting form
opaque. Captured syntax nested beneath that head MUST continue expansion using
the macro environment of its source module; literal template syntax continues
using the macro definition's module.

## 5. Macro invocation algorithm

```text
invokeMacro(binding, cursor, category, context):
  create invocation record and introduction scope
  derive matcher input under the use-site scope policy
  for rule in source order:
    restore cursor checkpoint
    attempt rule matcher
    if matcher fails, retain ranked failure
    if matcher succeeds:
      ask surrounding consumer whether the consumed extent is admissible
      if inadmissible, retain boundary failure
      apply binding contracts
      instantiate template with scoped captures and introduction scope
      check progress and resource limits
      expand replacement in category
      return expanded result and original unconsumed cursor
  report merged no-rule diagnostic
```

The macro consumes original input once. Nested expansion of its replacement does
not consume more original tokens unless the macro pattern captured them.

A `stmt` replacement may enforest as one or more consecutive statements. The
result remains one macro replacement container while its statement children are
expanded and then flattened into the surrounding statement list. This permits a
single declaration macro to introduce multiple same-scope declarations without
adding a JavaScript block scope.

## 6. Progress and termination

An expansion fingerprint contains:

```text
(macro binding ID, category, phase, input structural hash, environment epoch)
```

The invocation stack rejects a repeated fingerprint before the prior invocation
finishes. Recursive expansion can use the same macro when its input hash changes.
Global limits still bound growing rewrites.

Syntax-class recursion uses a separate parser-call fingerprint containing class,
cursor, category, precedence floor, and environment epoch.

## 7. Expression enforestation

The expression consumer uses Pratt parsing over syntax terms.

```text
parseExpr(cursor, minBindingPower):
  left := parsePrefix(cursor)

  loop:
    candidate := inspectPostfixOrInfix(left.rest)
    if no candidate, return left
    powers := bindingPowers(candidate)
    if powers.left < minBindingPower, return left
    left := consumeCandidate(left, candidate, powers.right)
```

`parsePrefix` resolves, in order:

1. a core-shadowing prefix macro;
2. a built-in TypeScript prefix form;
3. an ordinary prefix macro;
4. a primary expression.

`inspectPostfixOrInfix` checks macro operators and TypeScript operators visible
in the environment. An operator binding supplies left and right binding powers.
For left-associative precedence `p`, use `(p, p + 1)`; for right-associative use
`(p, p)`. Nonassociative operators reject another operator in the same band.

The consumer wraps its result in `ProtectedSyntax` with outer precedence.
Template insertion compares the captured and destination precedence and adds
parentheses when omission would change grouping.

## 8. TypeScript built-in parsing boundary

The project will not implement TypeScript semantics. Consumers implement enough
grammar to determine extent and bindings. A version adapter validates protected
fragments or the expanded file through the official parser.

Each consumer documents its owned grammar subset. Tests compare it against the
supported TypeScript parser corpus. A consumer mismatch produces a compiler
compatibility defect, not undefined macro behavior.

The assembled expanded file MUST pass the official TypeScript parser and
semantic checker. Successful fragments MUST NOT be wrapper-parsed individually.
Wrapper parsing MAY act as a diagnostic-recovery oracle after complete-file
validation fails, but cannot make an invalid complete file acceptable. ADR-0008
records the measured choice.

## 9. Statement and item consumers

The statement consumer recognizes block structure, terminators, control-flow
heads, declaration starts, expression statements, and macro heads. It delegates
expressions and bindings to their consumers.

The item consumer owns sequential definition contexts. It distinguishes
compile-time imports/definitions from runtime TypeScript items. Macros in item
position can emit several items.

Automatic semicolon insertion follows TypeScript token and line-break rules.
Patterns that include a semicolon consume it. A pattern can call a syntax class
that accepts an optional terminator through a named class, rather than hidden
matcher behavior.

## 10. Type and binding consumers

The type consumer handles TypeScript precedence, conditional types, unions,
intersections, function types, type operators, generics, indexed access, mapped
types, templates, and macro heads.

The binding consumer returns a skeleton:

```ts
interface BindingSkeleton {
  syntax: ProtectedSyntax;
  names: readonly BindingName[];
  shape: "identifier" | "array" | "object";
}
```

The template and hygiene packages use this skeleton to register bindings without
reparsing printed text.

## 11. Local and generated macro behavior

- A local macro lives in the lexical definition context that contains it. A
  macro emitted into a block is visible for the rest of that block and no
  further; a macro emitted at module level is visible to the items that follow
  it. A definition written by hand inside a block is not yet processed and is
  reported rather than emitted.
- A macro template can emit a macro definition in item or statement definition
  context.
- Generated definitions pass through macro-language parsing and validation.
- A generated macro captures definition-site syntax scopes from the template
  that generated it.
- A generated macro cannot become visible before its generated declaration. A
  name used above the definition that would give it meaning is reported, because
  the invocation would otherwise be emitted as a call to a name the output does
  not define.

## 12. Expansion trace

Each invocation emits:

```ts
interface MacroTraceEvent {
  invocationId: InvocationId;
  parent: InvocationId | undefined;
  binding: BindingId;
  category: SyntaxCategory;
  phase: Phase;
  invocationOrigin: OriginId;
  attemptedRules: readonly RuleAttempt[];
  selectedRule: RuleId | undefined;
  captures: readonly CaptureSummary[];
  scopesIntroduced: readonly ScopeId[];
  outputOrigins: readonly OriginId[];
  cache: "miss" | "hit";
}
```

Trace-off mode can omit successful event details but retains data needed for
error diagnostics and source mapping.

## 13. Expansion invariants

- Successful expansion returns syntax valid for the requested category after
  recursive expansion.
- Rule failure restores cursor, captures, scopes, and budget except charged work.
- Expansion order does not depend on hash-map iteration.
- A macro sees the lexical environment at its invocation plus its definition
  context according to hygiene rules.
- A macro result contains no unexpanded macro definition intended for the same
  definition context after that context finishes.
- Limits and cancellation cannot publish a cache entry for a partial result.

## 14. Required worked traces

Write full token-to-output traces for:

- a two-step threading macro;
- three sequential `do` bindings;
- implicit return with a statement prefix and final expression;
- one custom right-associative operator mixed with `+`;
- ADT declaration followed by a match expression;
- a `method` declaration that generates an invocation macro;
- a local core-shadowing `function` macro.
