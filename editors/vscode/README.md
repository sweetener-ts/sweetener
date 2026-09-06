# Sweetener for Visual Studio Code

Syntax highlighting for `.sts` and `.stsx`.

## What it does

`.sts` and `.stsx` are unknown extensions to an editor, so they open as plain
text: no highlighting, no bracket matching, no comment toggling. This
contributes a language for each, with a grammar that embeds VS Code's own TSX
grammar and adds the syntax TypeScript does not have — `for syntax` imports,
`syntax` and `operator` definitions, `rule … => …`, `$capture:class`, and
template operations such as `#core`.

It also gives Prettier somewhere to attach: `@sweetener/prettier-plugin`
already declares these two language ids, so with both installed, formatting a
`.sts` from the editor works the way it does for every other file.

## What it deliberately does not do

There is no language server here, so nothing type-checks a `.sts` in the
editor. That is on purpose rather than unfinished: associating these files with
the built-in `typescript` language would start TypeScript's own service on
them, and it would report every macro definition and every macro invocation as
a syntax error. Highlighting without diagnostics is worth more than
highlighting with wrong ones.

For checking, run `sweetener check` — or `sweetener watch`, which reports as
you edit. Diagnostics come back mapped to the `.sts` line you wrote.

Ordinary `.ts` and `.tsx` files that _import_ a `.sts` module do get full
editor support, including completions and type errors across the boundary, once
the project turns on `sweet.sourceDeclarations`. That writes the `.d.sts.ts`
files TypeScript resolves `./main.sts` through, so the editor's own TypeScript
sees the real types.

## Installing it

The extension is not published to the Marketplace. To use it from a checkout,
link it into your extensions directory and restart VS Code:

```sh
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/sweetener
```
