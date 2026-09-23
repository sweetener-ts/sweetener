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

## What it deliberately does not do

There is no language server. These languages are not Zed's `TypeScript` or
`TSX`, so a settings block for those languages — `typescript-ls`, `oxlint`,
`oxfmt` — does not apply here. Do not add a `file_types` entry that maps
`sts` or `stsx` onto TypeScript or TSX. That would start TypeScript's
language server on the file and report every macro as a syntax error.

For checking, run `sweetener check`, or `sweetener watch`.

Formatting is not wired to Prettier's TypeScript parser. With
`@sweetener/prettier-plugin` installed in the project, format `.sts` and
`.stsx` through that plugin.

## Installing it

The extension is not in the Zed extension registry. From a checkout, install
it as a dev extension:

1. Open the command palette and run `zed: install dev extension`.
2. Choose this directory, `editors/zed`.

Zed downloads and compiles the grammars on install. Reinstall after the
queries change.
