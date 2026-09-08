---
name: sweetener
description: Write hygienic macros for TypeScript with Sweetener — declaring macros in .sts files, running the compiler, and reading its diagnostics.
---

# Sweetener

Sweetener extends TypeScript syntax with macros. Macro-enabled files use the
`.sts` and `.stsx` extensions and expand into ordinary TypeScript, which the
real TypeScript compiler then type-checks and emits. Nothing about the type
system is reimplemented.

## Start a project

```sh
sweetener init my-app
```

In a directory with no `package.json`, that writes `package.json`,
`tsconfig.json`, and a `src/` with a macro definition and a file that uses it.
Install, then:

```sh
npm run check   # expand and type-check
npm run build   # expand, type-check, and emit into dist/
npm run watch   # rebuild on change
```

Run from a clone of the Sweetener repository, `init` points the project at that
checkout rather than at the registry, and says so. Build the checkout once
before installing.

## Add macros to a project you already have

Run the same command in it. `init` reads what the project depends on, adds a
`sweetener.json` listing the files to expand and a starter macro under `src/`,
and prints the integration that host needs with the config to paste:

| Host                                                | Integration                                        |
| --------------------------------------------------- | -------------------------------------------------- |
| Vite, Astro, Nuxt, SvelteKit, Solid Start, TanStack | `@sweetener/unplugin`                              |
| Bun                                                 | `@sweetener/unplugin/bun`, as a `Bun.build` plugin |
| Next, webpack                                       | `@sweetener/webpack-loader`                        |
| Parcel                                              | `@sweetener/parcel-transformer`                    |
| Jest                                                | `@sweetener/jest`                                  |
| Deno                                                | `@sweetener/cli`, expanding ahead of a `deno run`  |
| anything else                                       | the command line                                   |

Deno and Bun are recognised by their own config, so a project with no
`package.json` is still read as the project it is rather than an empty
directory.

On Deno, `deno run --import @sweetener/deno/register app.ts` expands sources as
they are imported, with no build step. `deno test` and `deno check` build their
module graph before loader hooks apply and so reject a `.sts` import; for those,
expand ahead of time with `emitStandalone` from `@sweetener/cli`.

## What it will and will not do

`init` prints every file it would create and then asks. Answer no and nothing
is written. Where there is no terminal to ask — a script, a pipeline — it says
so and stops rather than assuming; pass `--yes` to mean it.

It never edits or deletes a file that is already there. Bundler config belongs
to whoever wrote it, so it is printed for you to paste, not rewritten.

## Declare a macro

A macro is declared with `syntax`, and named for where it may be written —
`:expr` for expression position, `:stmt` for statement, `:item` for
declarations, `:type` for types.

```ts
export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}
```

A rule is a pattern and the syntax it expands to. `$value:expr` captures one
expression under the name `value`; write `$value` in the template to place it.

Macros are imported for compile time, and the import does not survive into the
emitted TypeScript:

```ts
import { twice } from "./macros.sts" for syntax;
export const pair = twice(21);
```

## What to reach for

- **Several shapes**: write several `rule`s. They are tried in order, and the
  first that matches wins. A trailing comma is a different shape and needs its
  own rule.
- **Repetition**: `$($item:expr),*` matches a comma-separated list, and
  `$($item),*` places it back.
- **Optional**: `$($value:expr)?`, tested in a template with
  `#if(present $value) { ... } #else { ... }`. The quantifier goes on the
  group, as it does for repetition; `$value:expr?` matches a literal `?`
  after the capture.
- **One shape or another in one rule**: `$left:tt | $right:tt`. The `|` is
  written with a space on either side of it, which is what tells it from a `|`
  the pattern matches literally, as in `$name |= $value:expr`.
- **A named shape used by several rules**: declare a syntax class.

  ```ts
  export syntax class Arm {
    fields { pattern: tt; body: expr; }
    rule { $pattern:tt => $body:expr }
  }
  ```

- **The source text of a capture**: `#text($value)`, which yields a string
  literal.
- **A name no call site can collide with**: just introduce it. Hygiene renames
  it if the call site already uses that name; nothing is required of you.

## Read the diagnostics

`No rule for macro X accepted this input: expected ...` names what the closest
rule was still waiting for, and the line under it points at the rule in the
macro definition that wanted it. When a macro will not match, compare the
input against that rule rather than guessing.

To describe a rule's intent in that message, give the rule an `expect` clause:

```ts
rule { field($name:ident : $kind:ident) }
  expect "a field type after the colon";
  => { [#text($name), #text($kind)] }
```

Other commands:

- `sweetener expand file.sts` prints the expansion of one file.
- `sweetener explain file.sts:line:column` reports where a position came from,
  as JSON.

## Know the limits

- **No editor support.** Editing `.sts` gives no hover, diagnostics, or
  go-to-definition. The loop is edit, run `check`, read the output.
- **Rename through a macro is declined.** A captured reference carries no proof
  of which binding each copy denotes, so the language service refuses rather
  than guessing.
- Macros run at compile time only, and cannot call host functions or inspect
  runtime values.
