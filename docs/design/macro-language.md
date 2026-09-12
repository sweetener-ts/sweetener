# Declarative Macro Language

## Status

This grammar is a proposal for prototyping. The playground corpus must drive the
final concrete syntax.

## Definition form

```ts
syntax doSteps:expr {
  rule { ($m:ident) { return $value:expr $(;)? } } => {
    $m.of($value)
  }

  rule {
    ($m:ident) {
      $name:binding <- $value:expr;
      $($rest:tt)*
    }
  } => {
    $m.flatMap($value, ($name) => doSteps ($m) { $($rest)* })
  }
}
```

This spelling intentionally resembles Rust repetition and Sweet.js concrete
templates. We should test a Sweet-style ellipsis alternative before choosing.

## Invocation categories

The annotation after a macro name declares its expansion category:

```ts
syntax unless:stmt { ... }
syntax effect:type { ... }
syntax derive:item { ... }
syntax field:classElement { ... }
syntax accessors:typeMember { ... }
```

A definition may list categories if it supplies one rule set per category. The
category determines where lookup occurs and what the result must consume after
expansion.

## Patterns

### Literals and variables

- Ordinary tokens match by kind and spelling.
- `$x` binds one token tree.
- `$x:expr` invokes the expression consumer and binds one protected expression.
- `$x:ident` requires an identifier.
- A literal identifier in a pattern resolves by binding identity when imported
  as a declared literal; punctuation matches by token value.

Initial syntax classes:

| Class          | Match                       |
| -------------- | --------------------------- |
| `token`        | One leaf token              |
| `tt`           | One token or balanced group |
| `ident`        | One identifier token        |
| `expr`         | One complete expression     |
| `stmt`         | One statement               |
| `item`         | One source/module item      |
| `type`         | One type                    |
| `binding`      | One binding name or pattern |
| `classElement` | One class member            |
| `typeMember`   | One interface/object member |
| `jsxChild`     | One JSX child               |

### Repetition

```ts
$($arg:expr),*    // zero or more, comma separated
$($arg:expr),+    // one or more, comma separated
$($part:tt)?      // zero or one
```

Variables used together inside a repetition have equal length at that depth.
Templates can repeat only variables captured at the corresponding repetition
depth. The macro-definition compiler reports depth and cardinality violations.

Nested repetition is legal. The capture representation is a persistent nested
sequence, not a flattened map.

### Alternatives and guards

Rules are tried in source order. Put structural alternatives in separate rules.
Version 1 has no arbitrary guard expressions; finite predicates such as token
kind or keyword exclusion can become syntax-class constraints. This keeps the
declarative engine deterministic and cacheable.

## Templates

Template tokens keep the macro definition's lexical context and receive a fresh
introduction scope at invocation. Substituted captures keep their call-site
context. Repetition splices captured sequences with their structure intact.

Parentheses printed around a substituted parsed expression depend on the output
precedence context. A `ParsedSyntax` capture preserves its grouping even if the
original source omitted delimiters.

## Hygiene controls

Defaults cover most macros:

- template identifiers refer to bindings visible at the macro definition;
- captured identifiers retain bindings from the invocation;
- new template bindings cannot capture invocation syntax;
- bindings introduced in one template can bind references introduced by the
  same template according to TypeScript scoping rules.

Explicit operations should be rare and searchable:

```ts
#callsite($name); // construct/retarget an identifier at the invocation
#definition($name); // construct/retarget at the definition
#fresh("temp"); // fresh generated binding hint
#capture($name); // deliberate capture, linted and traced
```

These spellings are the accepted declarative surface. Each operation produces
an origin and a template-operation trace event. `#index()` is valid only inside
a template repetition. Folds use the fixed form documented in the template
specification and cannot introduce host callbacks.

## Operators

```ts
export operator (<|>):expr {
  precedence 40;
  associativity right;
  rule { $left:expr <|> $right:expr } => {
    orElse($left, () => $right)
  }
}
```

Precedence belongs to the macro binding, not a global mutable table. Imports
that make two operators with the same spelling visible in one category create a
binding conflict. A precedence table should use named bands or relations in the
long term; numeric precedence is sufficient for the prototype.

## Macro modules and phases

Provisional import syntax:

```ts
import syntax { doSteps, operator(<|>) } from "@scope/macros";
```

The expander removes this declaration. Macro modules can import other macro
modules at the next phase. Runtime imports emitted by templates remain ordinary
TypeScript imports. Version 1 rejects a macro dependency cycle unless every
binding in the cycle is a declarative `syntaxrec` whose initialization has no
eager dependency.

## Rule selection and diagnostics

The first complete match wins. If a rule matches a prefix but leaves input that
the surrounding category cannot accept, expansion reports the leftover span and
the selected rule. If no rule matches, diagnostics rank the farthest failures
and merge their expected forms.

`sweet-ts explain` should display:

- resolved macro binding and category;
- rule attempts and selected rule;
- metavariable captures;
- template expansion;
- hygiene scopes and printed renames;
- nested expansion stack.

## Open syntax questions

- `.sts`, pragma opt-in, or macro-enabled `.ts` through build configuration.
- `syntax`, `macro`, or another definition keyword.
- Rust-style `$()*` versus Sweet/Racket-style ellipses.
- Braced templates versus tagged template literals.
- How syntax definitions coexist with editors before the language-service plugin
  loads.
- Whether custom operators belong in version 1 or the second milestone.
