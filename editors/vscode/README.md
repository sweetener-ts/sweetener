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

## How the grammar is put together

TypeScript's grammar owns the file. `source.sweetener` includes `source.tsx`
and nothing else, and everything Sweetener adds is an injection.

That is not a stylistic choice. A pattern listed beside `source.tsx` is
unreachable in practice: TypeScript opens a region at the first `export` or
`import` on a line, that region begins earlier than `syntax` or `for syntax`
does, and a top-level pattern cannot match inside a region another rule opened.
An injection is evaluated at every depth, which is the only way to reach the
tail of an import or the inside of a rule's template.

Each injection names the context it applies in, because every word the macro
language uses is an ordinary identifier in TypeScript. `rule`, `precedence`,
`left`, `fields` and `$name` mean nothing outside a macro definition, and
`#core` is spelled the same way as a private member. So the definition itself
is a region — `meta.macro.sweetener`, from the head in column one to the brace
that closes it in column one — and the clause keywords, captures, template
operations and expansion arrow are injected only inside it. Strings, comments,
and JSX text are excluded, with `${…}` substitutions and `{…}` expression
containers put back, since those hold code and the text around them does not.

`packages/prettier-plugin/test/vscode-grammar.test.ts` runs the grammar through
`vscode-textmate` and `vscode-oniguruma` — the tokenizer VS Code itself uses —
against VS Code's TSX grammar and the examples in this repository, and asserts
the scopes that come out.

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
