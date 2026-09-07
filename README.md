# Sweetener

**Hygienic, declarative macros for TypeScript.**

Sweetener lets a project extend TypeScript syntax while leaving type checking,
declaration generation, JavaScript emission, and editor semantics to the
official TypeScript compiler. Macro-enabled files expand from `.sts` or `.stsx`
into ordinary TypeScript, with source maps and expansion traces connecting the
result back to the source.

[Try the playground](https://sweetener-ts.github.io/sweetener/) — it runs the
real expansion pipeline locally in a Web Worker, with no server-side compiler.

> Sweetener is currently an alpha-stage project. The implementation and local
> release artifacts are complete, but the packages have not yet been published
> to npm.

## Define your own syntax

Sweetener macros are syntax-aware transformations rather than text
substitutions. You define them with concrete patterns and templates in `.sts`
modules, then import them explicitly for syntax.

### A pipeline operator

Define an infix operator, including its precedence and associativity:

```ts
// operators.sts
export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 40;

  rule { $value:expr |> $callee:ident } => {
    $callee($value)
  }
}
```

Then import and use it:

```ts
// main.sts
import { (|>) } from "./operators.sts" for syntax;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const result = [1, 2, 3] |> sum;
```

### Rewriting a core form

Core TypeScript syntax can only be intercepted when both the definition and the
import explicitly opt in with `shadows core`. Fallback rules preserve ordinary
behavior outside the special case:

```ts
// forms.sts
export syntax typeof:expr shadows core {
  literal globalThis.NaN as NaN;

  rule { typeof NaN } => {
    "NaN"
  }

  fallback rule { typeof $value:expr } => {
    #core(typeof $value)
  }
}
```

```ts
// main.sts
import { typeof } from "./forms.sts" for syntax shadows core;

const special = typeof NaN;
const value = { answer: 42 };
const ordinary = typeof value;
```

### Recursive syntax

Macros can recursively consume syntax while every capture remains a grammatical
unit—in this case an `expr`, `ident`, or token tree (`tt`):

```ts
// threading.sts
export rec syntax (->):expr {
  rule { (-> $value:expr) } => {
    $value
  }

  rule {
    (-> $value:expr, $next:ident($($argument:expr),*), $($rest:tt)+)
  } => {
    (-> $next($value, $($argument),*), $($rest)+)
  }

  rule { (-> $value:expr, $next:ident($($argument:expr),*),) } => {
    $next($value, $($argument),*)
  }

  rule { (-> $value:expr, $next:ident($($argument:expr),*)) } => {
    $next($value, $($argument),*)
  }
}
```

```ts
// main.sts
import { (->) } from "./threading.sts" for syntax;

const result = (->
  [1, 2, 3],
  map((value) => value + 1),
  filter((value) => value > 2),
);
```

The playground also includes threading, do notation, currying, protocols, CSP
operators, rewritten core forms, generated multi-part methods, and a combined
mini-language. Every example comes from the executable acceptance suite.

## A modern relative of Sweet.js

Sweetener draws directly from [Sweet.js](https://www.sweetjs.org/), the hygienic
macro system for JavaScript. It keeps Sweet.js's strongest ideas—concrete
patterns and templates, syntax classes, lexical macros, explicit compile-time
imports, and scope-set hygiene—while targeting TypeScript and making the public
macro language declarative.

Unlike Sweet.js, Sweetener does not emit JavaScript through its own full parser
or allow arbitrary JavaScript to execute during expansion. It emits TypeScript
for the official compiler, and its finite declarative macro language has no
filesystem, network, environment, process, clock, randomness, or evaluator
access. See the [Sweet.js design research](docs/research/sweetjs.md) and
[migration notes](docs/specifications/06-public-release-surface.md#8-migration-from-sweetjs)
for the detailed lineage.

## How it works

```text
.sts / .stsx
    ↓ lossless TypeScript-aware reader
delimiter trees
    ↓ hygienic, context-directed macro expansion
ordinary TypeScript + origin map + expansion trace
    ↓ official TypeScript compiler
.js + .d.ts + source maps + TypeScript diagnostics
```

Macro imports are explicitly compile-time-only:

```ts
import { (|>) } from "./operators.sts" for syntax;
```

Introduced identifiers receive definition and introduction scopes, while
captured identifiers retain their call-site identity. That keeps generated
bindings from accidentally capturing—or being captured by—user code.

## Start a project

```bash
sweetener init my-app
```

That writes the `package.json`, `tsconfig.json`, and `src/` a macro needs,
including a macro definition and a file that uses it. `npm run check` expands
and type-checks it; `npm run build` emits into `dist/`.

Until these packages are published, `init` points the new project at the
checkout it was scaffolded from and says so in its output, so build the
checkout once first.

[SKILL.md](SKILL.md) is a short reference for writing macros: declaring them,
the pattern forms, and how to read the compiler's diagnostics.

## Run it from source

Sweetener currently requires Node.js 24 and pnpm 11.18.0.

```bash
pnpm install
pnpm build
pnpm test
```

Run the browser playground locally:

```bash
pnpm playground
```

The CLI supports project checking, building, watching, expansion inspection,
and explanations:

```bash
sweetener check -p tsconfig.json
sweetener build -p tsconfig.json
sweetener watch -p tsconfig.json
sweetener expand src/main.sts
sweetener explain src/main.sts:12:8
```

## Documentation

- [Language and release surface](docs/specifications/06-public-release-surface.md)
- [Patterns and templates](docs/specifications/03-patterns-templates.md)
- [Syntax objects and hygiene](docs/specifications/02-syntax-objects-hygiene.md)
- [Compiler architecture](docs/specifications/01-compiler-architecture.md)
- [Build-tool integrations](docs/integrations.md)
- [Project status](STATUS.md)

## Project status

The compiler, CLI, browser playground, TypeScript host, language-service
mapping, integrations, compatibility checks, and alpha release artifacts are
implemented and tested locally. npm publication and a release tag remain
intentionally blocked until explicitly authorized. See [STATUS.md](STATUS.md)
for the generated capability dashboard and current validation evidence.

Two limits are worth knowing before adopting it. There is no editor
extension yet: the language-service mapping that one would be built on is
implemented and tested, but nothing ships that connects it to an editor, so
`.sts` files get no hover, diagnostics, or go-to-definition in an IDE today.
And renaming a symbol through a macro invocation is declined rather than
attempted, because a captured reference carries no proof of which binding
each copy denotes.
