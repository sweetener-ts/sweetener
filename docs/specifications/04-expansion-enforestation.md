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

A brace written among type arguments is an object type wherever it stands, so
its body is a member run: `class C extends make<{ timestamps }>() {}` reads
`timestamps` as a member, not as a class element, however the declaration
around the type arguments is written. The type arguments of a JSX tag are read
as types for the same reason, so a `type` macro in `<Comp<list<string>> />`
expands there, while what follows them is read as the attributes of the tag
they belong to.

An item list, a statement list, a class body and a member run are each written
with a separator that ends every unit: `;` throughout, and `,` as well in a
member run. A macro invocation spans the separator written after it, and that
separator is kept only where it terminates a unit the macro left open. A macro
that terminates what it emits therefore leaves behind no empty statement,
empty class member, or member of its own.

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
dispatch. Which core forms a binding meets depends on where it is dispatched:
an operator stands beside or between operands, where every core operator of its
spelling does; a macro heads an operand, so in an expression it meets only the
core forms that head one. A macro named `%` therefore needs no authorization,
since remainder is never written where an operand begins.

Syntax resolves macros against the module it was written in, identified by the
module scope its tokens carry. A template's tokens keep the scope of the module
defining the template, so a helper macro or operator a template uses expands
whether or not the call site imports it, including in the replacement of an
operator, which is produced while the call site is read.

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

`yield` is a prefix operator whose operand is an assignment expression, as in
TypeScript: `yield a + b` yields the sum.

A macro operator's right operand is read in one of three ways, tried in order:

1. A token run that some rule spells literally after the operator, when nothing
   after the run continues an operand. A rule `$value:expr |> await` makes
   `p |> await |> f` read `await` as the whole right operand, while
   `p |> await f` has `f` after it and is read as an expression.
2. An arrow function, when the operator declares `operand arrow;`. Its body
   ends at the next use of the same operator, so `x |> n => f(n) |> g` has
   `n => f(n)` as the right operand of the first pipe.
3. An expression at the operator's right binding power.

An operator's rules must account for all of its operands. A rule that matches
a prefix of them is not selected.

The header of `if`, `while`, `do`, `for`, `with`, and `switch` is read as
expressions: the whole header, or a `for` loop's initializer (declarators with
their initializers), test and update, or the object a `for...in` or `for...of`
walks. A header that does not read so is kept as written.

The consumer wraps its result in `ProtectedSyntax` with outer precedence, and
records its form when it is an unparenthesized conditional, arrow function,
assignment, `yield`, or `await`. Parentheses make an expression of no form.
Printing parenthesizes a protected expression that expansion placed where its
own operators could re-associate: one whose precedence is not already tighter
than the operator it is an operand of, and any conditional or arrow that is not
the whole body of an arrow. `??` beside an unparenthesized `||` or `&&`, and a
unary base of `**`, keep their parentheses.

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

## 15. Syntax parameters

A syntax parameter is a macro binding whose meaning a template adjusts for the
syntax it wraps, after Racket's `define-syntax-parameter` and
`syntax-parameterize`. It is declared with `syntax parameter` and imported like
any macro.

```text
export syntax parameter (%):expr;

export operator (|>):expr {
  fixity infix; associativity right; precedence 20;
  rule { $value:expr |> $body:expr }
  refine $body form not in (conditional, arrow, assignment, yield);
  => {
    #let(topic = $value) { #parameterize(required % = topic) { $body } }
  }
}
```

`#parameterize(name = replacement) { body }` resolves `name` where the template
wrote it. A name that is not a syntax parameter in scope reports `SWR4019`, and
the body expands without the parameterization. Otherwise the parameterization
is in effect for the expansion of the body, which follows expansion rather than
the text: a parameter written in a capture the body splices, or produced by a
macro the body invokes, refers to it too.

Where a parameter is dispatched:

- under a parameterization naming it, its head is replaced by a fresh copy of
  the nearest one's replacement, which is expanded in the parameter's category
  under the parameterizations that were in effect where the replacement was
  written -- so `#parameterize(it = [it, it])` means the enclosing `it`. A
  replacement of more than one node in an expression or type keeps the node
  that bounds it;
- with none in effect, a parameter with rules expands by them;
- with none in effect, a parameter without rules reports `SWR4018` at its head.

`#parameterize(required name = replacement) { body }` also requires the body to
use the parameter: once the body is expanded, if no use of the parameter was
dispatched under this parameterization, `SWR4022` is reported over the body. A
use under a nearer parameterization of the same parameter does not count. A
parameter used inside the operands of an operator no rule accepted is not
reported with `SWR4018`; the operator's own diagnostic covers it.

A parameter is measured by its head alone. What is written after it -- a call's
arguments, a member access -- is read around it as around any operand, so it
may stand wherever an operand may, however it is spelled. A punctuation-spelled
macro that is not an operator is dispatched only where an operand begins: after
something that ends an operand it is the TypeScript operator of the same
spelling, decided the way a scanner tells a regular expression from a division.
In `7 |> % % 4`, the first `%` is the parameter and the second is remainder.

## 16. Expression-level `let`

`#let(name = value) { body }` evaluates `value` once, binds `name` to it, and
evaluates to `body`. `name` is an identifier the template introduces, so hygiene
keeps it apart from call-site bindings of the same spelling. The value and the
body are expanded first, and the expansion then takes one of two forms:

- `((name) => body)(value)`, which gives each evaluation a binding of its own;
- `(name = value, body)`, with `let name;` declared at the start of the
  enclosing function body, after its directive prologue, or of the module when
  no function encloses it.

The second form is used when the expanded body suspends the function it stands
in: it holds an `await` or `yield` that is not inside a function, arrow, method
or class written within the body. A function wrapped around such a body would
change what the `await` or `yield` belongs to.

A function body is a brace that follows `=>`, or that follows a parameter list
not headed by `if`, `while`, `for`, `switch`, `catch`, `with`, or `for await`,
optionally with a return type between. A class body is not one. An arrow with a
concise body that needs a declaration is rewritten with a block body:
`(x) => { let name; return body; }`. Each call of a function has its own
variable, so concurrent calls of an async function do not share it.

A later evaluation of the same `#let` in one call -- the next iteration of a
loop, including a loop's test or update -- assigns the variable again. So that
a closure keeps the value of its own evaluation, each function, arrow, or class
in the body of the second form that reads `name` is wrapped as
`((name) => (closure))(name)`, taking a copy when it is created. A method or
accessor is copied through the object literal it is written in; an object
literal that itself holds an `await` or `yield` cannot be wrapped, and reports
`SWR4023`.
