# ADR-0009: Directive Opt-In and JavaScript Targets

Status: accepted  
Date: 2026-08-03  
Owners: Jimmy Miller

## Decision

A source file opts into macro expansion two ways:

1. A **macro extension** listed in `sweet.macroExtensions`. The file is owned by
   the expander and is rewritten to an ordinary virtual file. The supported
   extensions and their targets are a closed table:

   | Source  | Virtual |
   | ------- | ------- |
   | `.sts`  | `.ts`   |
   | `.stsx` | `.tsx`  |
   | `.sjs`  | `.js`   |
   | `.sjsx` | `.jsx`  |

   An extension outside this table is a configuration error.

2. A **`"use sweetener"` directive** in the file's opening directive prologue,
   in a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, or `.cjs` file.
   The file keeps its own name; its expanded form shadows the file on disk.
   Files without the directive are untouched.

The directive is a compile-time marker and is stripped from the expanded
output. It is recognized only in the directive prologue, so a mention in a
comment or a later string does not opt a file in.

Expansion targets JavaScript as well as TypeScript. The target follows from the
virtual file's extension, and the generated file is presented to TypeScript
under the matching `ScriptKind`. JavaScript output is therefore parsed and
checked as JavaScript: `allowJs` and `checkJs` apply, JSDoc types are honoured,
and JavaScript-only readings of ambiguous syntax are preserved.

A config-free path expands files with no `tsconfig.json`: `sweetener expand`
falls back to a standalone project, and `sweetener emit <files> --out-dir <dir>`
writes expanded sources without running TypeScript. `--out-dir` is required
because a directive-marked file keeps its own name and would otherwise be
overwritten.

## Context

The macro system was built against TypeScript, but nothing in the reader,
expander, hygiene model, or printer is TypeScript-specific. JavaScript is a
subset of the syntax the reader already accepts. Only the final hand-off to
TypeScript assumed a `.ts` target.

That assumption failed in two ways. The virtual-file name was computed by
slicing a fixed number of characters off the source name, so any extension
other than `.sts`/`.stsx` produced a wrong name; for `.js` the lookup missed
entirely and the _unexpanded_ macro source was handed to TypeScript. And
because every generated file was named `.ts`, legal JavaScript was parsed as
TypeScript: `f(a) < b > (c)` became a call with a type argument, `with` was
rejected, and JSDoc types were ignored.

Requiring a rename to `.sts` is also a poor fit for JavaScript projects, which
ADR-0002 anticipated when it deferred a file-level pragma.

## Options measured

### Rename to a macro extension only

Works, and remains supported. It forces every adopting file to change its name
and every importer to change its specifier, which is a large diff for an
existing JavaScript codebase and interacts badly with tools keyed on `.js`.

### `"use sweetener"` directive

Matches the existing `"use strict"` precedent, needs no rename, and leaves the
file's identity to its extension. Detection costs one prologue scan per
candidate file, guarded by a substring check, so files that never mention the
directive do not pay for a parse. The measured cost across the sample projects
is not distinguishable from noise.

### Bypass TypeScript for JavaScript entirely

Rejected as the default. Routing JavaScript through the TypeScript host keeps
source maps, the language service, diagnostic remapping, and downlevelling with
no new emit path. It is offered as the explicit `emit` command instead, for
projects that do not want a `tsconfig.json`.

## Consequences

- The virtual-name, script-kind, and reader-variant decisions come from one
  table rather than from string slicing at five separate call sites.
- `allowJs` is forced on when a project lists JavaScript files explicitly or
  configures a JavaScript macro extension. Files reached only through `include`
  globs are unaffected, so no project's file set silently widens.
- Type syntax in a JavaScript target is not diagnosed by the expander; a macro
  that emits type annotations into a `.js` file fails in TypeScript instead.
  This keeps macros portable between targets at the cost of a later error.
- `samples/external/javascript-project` validates the directive, JavaScript
  checking, JSDoc, an untouched module, and the config-free `emit`.

## Reversal condition

Revisit the directive if prologue detection proves unreliable in a real editor
or bundler integration, or if shadowing a file with its own expanded form
confuses tools that watch the original path.
