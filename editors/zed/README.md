# Sweetener for Zed

Syntax highlighting for `.sts` and `.stsx`.

## What it does

`.sts` and `.stsx` are unknown extensions, so Zed opens them as plain text.
This extension registers two languages, separate from Zed's TypeScript and TSX:

| Language             | Extension |
| -------------------- | --------- |
| Sweetener TypeScript | `.sts`    |
| Sweetener TSX        | `.stsx`   |

Highlighting, brackets, comments, indentation, and the outline use the same
Tree-sitter grammars Zed uses for TypeScript and TSX. Comments, strings, JSX,
and ordinary TypeScript color as they do in `.ts` and `.tsx`.

Sweetener's own forms (`for syntax`, `syntax` / `operator` definitions,
`rule`, `$capture`, `#if`) are not nodes in that grammar, so they highlight
only as far as TypeScript's error recovery goes. The VS Code extension paints
those with a TextMate injection; Zed has no equivalent, and this extension
does not reuse that grammar.

## Language server

Installing the extension starts the server. There is no second executable.
Zed finds `node` on the worktree `PATH` and runs the `sweetener` CLI with
`--lsp --stdio`, the same shape as TypeScript's native server. The working
directory is the worktree root, which has to contain `sweetener.json` or
`tsconfig.json`. No binary path and no extra arguments.

In this checkout the CLI is `packages/cli/bin/sweetener.mjs` rather than
an install under `node_modules`. The extension runs that file. The project
is still the working directory Zed gives the process, which is the opened
folder. Run `pnpm build` once so the CLI has its compiled output. The server
is not bundled in the extension archive.

Set `lsp.sweetener-lsp.binary` only when `sweetener` is not in that place,
or when you need a flag the default command does not pass.

These languages stay separate from Zed's TypeScript and TSX, so a settings
block for those languages does not apply here. A `file_types` entry that maps
`sts` or `stsx` onto TypeScript or TSX would start TypeScript's language
server on the file and report every macro as a syntax error.

For checking from a terminal, run `sweetener check`, or `sweetener watch`.

Formatting is not wired to Prettier's TypeScript parser. With
`@sweetener/prettier-plugin` installed in the project, format `.sts` and
`.stsx` through that plugin.

## Installing it

The extension is not in the Zed extension registry. From a checkout, install
it as a dev extension:

1. Open the command palette and run `zed: install dev extension`.
2. Choose this directory, `editors/zed`. Choose the directory that contains
   `extension.toml`, not `editors/zed/languages`.

Zed downloads and compiles the grammars on install, and compiles this
directory's Rust library for `wasm32-wasip2`. That target needs Rust 1.98.1.
Reinstall after the queries or the Rust library change.

A GitHub Release of this repository also carries
`sweetener-zed-<version>.tar.gz`. That archive is this directory plus the
`extension.wasm` the release workflow built.
