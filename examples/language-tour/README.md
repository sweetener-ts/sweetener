# Language tour

Runnable, type-checked Sweetener examples organized by feature rather than by
framework. `recovered/` contains the playground examples. `new/` contains
examples written for this catalog.

Each directory is self-contained: macro definitions live beside the source
that imports and uses them. Run every example from the repository root:

```sh
pnpm --dir examples/language-tour build
```

## Playground examples

| Example               | Demonstrates                                                    |
| --------------------- | --------------------------------------------------------------- |
| `adt`                 | Algebraic data types and constructor matching                   |
| `core-rewrites`       | Opt-in interception of core TypeScript forms                    |
| `csp`                 | Channel-style operators                                         |
| `currying`            | Generated curried functions                                     |
| `do-notation`         | Sequencing computations with recursive syntax                   |
| `implicit-return`     | Function bodies whose final expression is returned              |
| `multi-part-methods`  | Linear and regular-grammar generalised method names             |
| `new-language`        | Records, extension methods, optional types, and a call operator |
| `operators`           | Prefix, infix, and core-shadowing operators                     |
| `protocols`           | Protocol declarations and implementations                       |
| `rewritten-if`        | An opted-in rewrite of a core statement form                    |
| `threading`           | Recursive Clojure-style threading                               |
| `pipeline`            | A compact left-to-right pipeline operator                       |
| `unless`              | User-defined statement-level control flow                       |
| `debug-assert`        | Source-aware debugging and assertions                           |
| `generated-records`   | Classes generated from record declarations                      |
| `recursive-threading` | Reader-oriented threading                                       |
| `structural-matching` | Nested patterns, binders, guards, and fallbacks                 |
| `readable-adt`        | Reader-oriented algebraic data types                            |
| `jsx-control-flow`    | `when` and `each` blocks spanning JSX children                  |
| `reactive-signals`    | A macro that generates lexical read/write macros                |

## Twenty additional examples

| Example                | Demonstrates                                   |
| ---------------------- | ---------------------------------------------- |
| `clamp-expression`     | A function-like expression macro               |
| `nullish-fallback`     | Reusable nullish-default syntax                |
| `duplicate-expression` | Repeating one capture in a template            |
| `variadic-array`       | One-or-more repetition and separator rewriting |
| `string-wrapper`       | Captures embedded in a template literal        |
| `guard-clause`         | A custom statement with an `else` body         |
| `repeat-block`         | Hygienic generated loop bindings               |
| `readonly-list-type`   | A parameterized type macro                     |
| `optional-type`        | Union types generated from custom syntax       |
| `generated-constant`   | An item macro introducing a following binding  |
| `pipeline-operator`    | A left-associative custom operator             |
| `power-operator`       | A right-associative core-shadowing operator    |
| `vector-prefix`        | A prefix operator over repeated expressions    |
| `object-is-equality`   | Replacing core equality with `Object.is`       |
| `source-aware-debug`   | Turning captured source text into data         |
| `source-aware-check`   | Source-aware invariant messages                |
| `generated-pair-class` | A generic class from one declaration           |
| `generated-function`   | A macro-generated callable binding             |
| `conditional-log`      | A statement macro with multiple expressions    |
| `invariant-expression` | An expression macro that can throw             |

The `new-language` example uses its records, extension method, optional type,
and method-call operator. Its `macros.sts` also defines a `module` wrapper,
which `main.sts` does not use because TypeScript 6 rejects the generated
namespace node.
