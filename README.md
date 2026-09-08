# Sweetener

**Hygienic, declarative macros for TypeScript.**

Sweetener lets a project extend TypeScript syntax while leaving type checking,
declaration generation, JavaScript emission, and editor semantics to the
official TypeScript compiler. Macro-enabled files expand from `.sts` or `.stsx`
into ordinary TypeScript, with source maps and expansion traces connecting the
result back to the source.

[Try the playground](https://sweetener-ts.github.io/sweetener/). It runs the
real expansion pipeline locally in a Web Worker, with no server-side compiler.

> Sweetener is alpha. Packages go out under the `alpha` dist-tag. These are the
> first versions of their names, so a plain `npm install` gives you one of them,
> with nothing stable behind it. Public TypeScript signatures may change before
> `1.0`. The language carries its own version, and changing how it behaves
> requires a new one.

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

A macro can call itself. A base case and an inductive case are enough to build
a form that takes as many parts as you write:

```ts
// cond.sts
export rec syntax cond:expr {
  rule { cond { else => $result:expr } } => { $result }
  rule { cond { else => $result:expr, } } => { $result }
  rule { cond { $test:expr => $result:expr, $($rest:tt)+ } } => {
    $test ? $result : cond { $($rest)+ }
  }
}
```

```ts
// main.sts
import { cond } from "./cond.sts" for syntax;

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number };

export const area = (shape: Shape): number =>
  cond {
    shape.kind === "circle" => Math.PI * shape.radius ** 2,
    else => shape.side ** 2,
  };
```

You can see the recursion in what it produces. Each arm nests inside the
alternative of the one before it:

```ts
export const area = (shape: Shape): number =>
  shape.kind === "circle" ? Math.PI * shape.radius ** 2 : shape.side ** 2;
```

The result is an ordinary conditional, so TypeScript narrows through it.
`shape.radius` and `shape.side` each type-check in their own arm, and if you
reach for the wrong one the error lands on the line you wrote:

```text
main.sts:9:38 TS2339: Property 'side' does not exist on type '{ kind: "circle"; radius: number; }'.
```

And `cond` is total by construction. There is no rule without an `else`, so
leaving it out is a compile error that points at the rules it tried:

```text
main.sts:4:3 TS4001: No rule for macro cond accepted this input: expected `else`.
  cond.sts:2:17 The closest rule was still expecting syntax here
```

The [playground](https://sweetener-ts.github.io/sweetener/) carries nine more:
sum types with an exhaustive match, structural pattern matching with no runtime
behind it, signals, records that generate declarations rather than expressions,
an operator with its own precedence, a statement macro, JSX, React
memoization, and capturing a fragment's own source text. Every one of them is
expanded by the same worker the site ships, checked on each build.

## A modern relative of Sweet.js

Sweetener draws directly from [Sweet.js](https://www.sweetjs.org/), the hygienic
macro system for JavaScript. It keeps Sweet.js's strongest ideas (concrete
patterns and templates, syntax classes, lexical macros, explicit compile-time
imports, and scope-set hygiene) while targeting TypeScript and making the
public macro language declarative.

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
bindings from capturing user code, or being captured by it.

## Use it in a project you already have

Run `init` inside it. It reads what you already depend on and prints the
integration your host needs, with the config to paste. It writes a
`sweetener.json` listing the files to expand, plus a starter macro under `src/`.
You see every file it would create before it writes one, and it leaves alone
anything already there.

```bash
npm install --save-dev @sweetener/cli@alpha
npx sweetener init
```

| Host                                                     | What it wires up                       |
| -------------------------------------------------------- | -------------------------------------- |
| Vite, Astro, Nuxt, SvelteKit, SolidStart, TanStack Start | `@sweetener/unplugin/vite`             |
| Rsbuild, Farm                                            | `@sweetener/unplugin/rsbuild`, `/farm` |
| Bun                                                      | `@sweetener/unplugin/bun`              |
| Next.js, webpack                                         | `@sweetener/webpack-loader`            |
| Parcel                                                   | `@sweetener/parcel-transformer`        |
| Jest                                                     | `@sweetener/jest`                      |
| Deno                                                     | `@sweetener/deno/register`             |
| Node                                                     | `@sweetener/node/register`             |
| anything else                                            | the command line                       |

`@sweetener/unplugin` also has entry points for Rollup, Rolldown, esbuild, and
Rspack, and `@sweetener/prettier-plugin` formats `.sts` and `.stsx`. `init`
recognises Deno and Bun from their own config files, so it identifies a project
that carries no `package.json`. [Build-tool
integrations](docs/integrations.md) covers each host in full.

### Starting from nothing

```bash
npx sweetener init my-app
```

That writes the `package.json`, `tsconfig.json`, and `src/` a macro needs,
including a macro definition and a file that uses it. `npm run check` expands
and type-checks it; `npm run build` emits into `dist/`.

## Importing a macro module from ordinary TypeScript

`tsc` does not know what a `.sts` is. In a `.ts` file,
`import { pair } from "./main.sts"` fails to resolve, which breaks the
`tsc -b && vite build` script a Vite app ships with. Turn on source
declarations:

```json
{
  "compilerOptions": { "allowArbitraryExtensions": true },
  "sweet": { "sourceDeclarations": true },
  "files": ["src/macros.sts", "src/main.sts"]
}
```

`sweetener build` then writes `src/main.d.sts.ts` beside each source, which is
the name TypeScript resolves `./main.sts` through. Types cross the boundary:
assign a `readonly number[]` export to a `string` and plain `tsc` rejects it.
Your editor rejects it too, because your editor runs the same compiler. Add
`*.d.sts.ts` and `*.d.stsx.ts` to `.gitignore`.

This replaces hand-written `declare module "*.sts"` blocks, which restate every
export and then go stale without telling you.

## The command line

```bash
sweetener check -p tsconfig.json    # type-check through the official compiler
sweetener build -p tsconfig.json    # expand and emit
sweetener watch -p tsconfig.json    # rebuild on change
sweetener expand src/main.sts       # show the expanded TypeScript
sweetener explain src/main.sts:12:8 # explain what expanded at a position
```

[SKILL.md](SKILL.md) is a short reference for writing macros: declaring them,
the pattern forms, and how to read the compiler's diagnostics.

## Documentation

- [Language and release surface](docs/specifications/06-public-release-surface.md)
- [Patterns and templates](docs/specifications/03-patterns-templates.md)
- [Syntax objects and hygiene](docs/specifications/02-syntax-objects-hygiene.md)
- [Compiler architecture](docs/specifications/01-compiler-architecture.md)
- [Build-tool integrations](docs/integrations.md)
- [Contributing](CONTRIBUTING.md)
- [Project status](STATUS.md)

## Project status

The compiler, CLI, [browser playground](https://sweetener-ts.github.io/sweetener/), TypeScript host,
language-service mapping, integrations, and compatibility checks are
implemented and tested.
Every documented host is verified by installing the packed tarballs into a
project created from scratch, not from inside this repository. See
[STATUS.md](STATUS.md) for the generated capability dashboard and current
validation evidence.

Three limits, before you adopt it.

**Editor support is highlighting only.** `editors/vscode` contributes a grammar
for `.sts` and `.stsx`. It is not on the Marketplace, so link it from a
checkout. It ships no language server on purpose: registering `.sts` as
`typescript` starts TypeScript's own service on the file and paints every macro
definition as a syntax error. So a `.sts` gets no hover, diagnostics, or
go-to-definition, and `sweetener check` and `watch` cover that instead. A `.ts`
file importing a `.sts` does get completions and errors, through the
declarations above.

**Sweetener declines to rename through a macro invocation.** A captured
reference carries no proof of which binding each copy denotes, so it refuses
rather than guessing.

**macOS and Linux.** Nobody has run this on Windows.
