# Build-tool integrations

Sweetener expands source before TypeScript, JSX, minification, and bundling.
Every adapter delegates to `@sweetener/compiler`; compile-time macro imports
never enter the runtime module graph.

## Prettier

`@sweetener/prettier-plugin` registers `.sts` and `.stsx` with Prettier 3:

```js
// prettier.config.mjs
import sweetener from "@sweetener/prettier-plugin";

export default { plugins: [sweetener] };
```

The formatter reads delimiter structure with `@sweetener/reader`, so it accepts
user-defined syntax without teaching Prettier every macro invocation. For
application files, it masks compile-time imports — including bindings named by
an operator, `(|>)`, or by a core form being shadowed, `typeof` — and imported
item-macro prefixes, while Prettier formats the surrounding TypeScript and JSX,
then restores the Sweetener syntax. Files that cannot be represented this way
use a conservative delimiter-based fallback; that fallback preserves template
and JSX whitespace because it can have runtime meaning.

**It normalizes layout and leaves the tokens alone.** A semicolon and a quote
character are both real tokens to a macro matcher, and a macro can match on one
not being there: the implicit-return example in the language tour returns a
function's final expression, and what distinguishes that from an expression
statement is the absence of a `;`. So `semi` and `singleQuote` are not applied
to `.sts` and `.stsx` — a file keeps whichever style it is written in, and
everything around it is still formatted. Where no printing preserves every
token, the file is left as it was.

## Editors

`editors/vscode` contributes a language for `.sts` and `.stsx` with a grammar
that embeds VS Code's own TSX grammar and adds the syntax TypeScript does not
have. Without it these open as plain text: no highlighting, no bracket
matching, no comment toggling.

```sh
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/sweetener
```

It contributes no language server, deliberately. Associating these files with
the built-in `typescript` language would start TypeScript's own service on
them, and every macro definition and invocation would be reported as a syntax
error. For checking, run `sweetener check`, or `sweetener watch` to have it
report as you edit.

Ordinary `.ts` and `.tsx` files that import a `.sts` module do get completions
and type errors across the boundary — see source declarations below. The two
language ids match the ones `@sweetener/prettier-plugin` declares, so with both
installed, formatting a `.sts` from the editor works as it does elsewhere.

## Universal plugin

`@sweetener/unplugin` provides these entry points:

| Entry point | Verified host                                           |
| ----------- | ------------------------------------------------------- |
| `/vite`     | Vite development and production builds                  |
| `/rollup`   | Rollup production build                                 |
| `/rolldown` | Rolldown production build                               |
| `/esbuild`  | esbuild build and macro-only incremental rebuild        |
| `/webpack`  | webpack production build                                |
| `/rspack`   | Rspack production build                                 |
| `/rsbuild`  | Rsbuild production build                                |
| `/bun`      | Bun runtime loading and production builds               |
| `/farm`     | Farm native load/transform adapter and production build |

Vite-based frameworks such as Astro, SvelteKit, SolidStart, Vitest, and Nuxt
use the Vite entry. webpack- and Rspack-based frameworks use their respective
entry. Farm has a native implementation because its generic plugin bridge
cannot assign a module type after attempting to load an unknown `.sts` file.

```ts
// vite.config.ts
import { resolve } from "node:path";
import { defineConfig } from "vite";
import sweetener from "@sweetener/unplugin/vite";

export default defineConfig({
  plugins: [
    ...sweetener({
      configFile: resolve(import.meta.dirname, "sweetener.json"),
    }),
  ],
});
```

Pass `configFile` unless the project's own `tsconfig.json` lists the macro
sources. Without it the adapter discovers the nearest `tsconfig.json`, and a
file that config does not list is not opted into expansion. `sweetener init`
detects the host and prints the wiring for it, including this.

Expansion emits TypeScript. The Vite entry point follows it with Vite's own
Oxc transform; esbuild and Bun are told which loader to read the output with;
the remaining entry points have no TypeScript of their own, so the adapter
strips types for them using the Sweetener project's compiler options.

### Rsbuild and Farm

Both take one plugin rather than the array Vite's entry returns:

```ts
// rsbuild.config.ts
import { resolve } from "node:path";
import { defineConfig } from "@rsbuild/core";
import sweetener from "@sweetener/unplugin/rsbuild";

export default defineConfig({
  plugins: [
    sweetener({ configFile: resolve(import.meta.dirname, "sweetener.json") }),
  ],
  source: { entry: { index: "./src/index.ts" } },
});
```

```ts
// farm.config.ts
import { resolve } from "node:path";
import { defineConfig } from "@farmfe/core";
import sweetener from "@sweetener/unplugin/farm";

export default defineConfig({
  plugins: [
    sweetener({ configFile: resolve(process.cwd(), "sweetener.json") }),
  ],
  compilation: { input: { index: "./src/index.ts" } },
});
```

Farm's config is `process.cwd()`, not `import.meta.dirname`, because Farm
bundles `farm.config.ts` into `node_modules/.farm` before running it — the
config resolves relative to where it ends up, not to where it was written.

### React and Fast Refresh

React hook macros work in `.stsx`, but `@vitejs/plugin-react` does not include
custom extensions in its default transform filter. Include `.stsx` explicitly
so the expanded module receives Fast Refresh instrumentation:

```ts
export default defineConfig({
  plugins: [
    ...sweetener({ configFile }),
    react({ include: /\.(?:[jt]sx|stsx)$/u }),
  ],
});
```

The React example emits an ignored `.sweetener/main.tsx` for
`eslint-plugin-react-hooks`. This makes the official Rules of Hooks inspect the
real expanded hook calls rather than attempting to parse macro syntax. Normal
Sweetener checking remaps TypeScript diagnostics from generated hook calls back
to their captured `.stsx` source regions.

## Bun runtime and bundler

The Bun entry is a native synchronous-setup plugin, so the same adapter works
with both `Bun.plugin()` at runtime and the `plugins` option of `Bun.build()`.
For direct `.sts` imports, preload a small registration module from
`bunfig.toml`:

```toml
preload = ["./sweetener.preload.ts"]
```

```ts
// sweetener.preload.ts
import { resolve } from "node:path";
import sweetener from "@sweetener/unplugin/bun";

Bun.plugin(
  sweetener({ configFile: resolve(import.meta.dir, "sweetener.json") }),
);
```

Typed `.sts` and `.stsx` output is handed back through Bun's TypeScript loaders.

**`bun --watch` does not reload for a `.sts` change.** Bun watches the files it
resolved itself; a module a plugin loaded is not one of them, and a macro module
imported `for syntax` never enters its graph at all. Editing an ordinary `.ts`
does restart the process, and the reload that follows re-expands from disk —
macro dependencies are part of the session's content-aware cache, so a rule
changed in the meantime takes effect. A `.sts`-only change needs a restart.

## Deno tasks

`@sweetener/deno/register` installs Deno's `module.registerHooks`, so Deno runs
`.sts` directly. Name it the way Deno names an npm package:

```sh
SWEETENER_CONFIG=./sweetener.json deno run \
  --import npm:@sweetener/deno/register src/main.sts
```

A bare `@sweetener/deno/register` is resolved as a path, not as a package, so
Deno reports the specifier as a missing file. `SWEETENER_CONFIG` names the
project config, since a preload takes no arguments.

The checked-in example names a path inside the package instead, because it
links the workspace copy rather than installing one from npm, and `npm:` will
not reach a linked package.

`deno check` is a separate matter: it parses `.sts` with its own TypeScript
front end and cannot read macro syntax. The checked-in Deno example therefore
also uses Deno-native tasks to expand `.sts` into an ignored `.sweetener` tree
for checking:

```sh
deno task check
deno task start
deno task dev
```

`deno task dev` watches the macro sources, re-expands them, and restarts the
Deno server. This keeps the generated boundary explicit while preserving
Deno's native checker, permission model, watcher, test runner, and HTTP server.

## webpack, Rspack, and Turbopack loader

`@sweetener/webpack-loader` implements the webpack loader API, including source
maps and macro dependency registration. It is verified with webpack, Rspack,
and a Next production build using Turbopack.

```js
export default {
  module: {
    rules: [
      {
        test: /\.sts$/,
        use: [{ loader: "@sweetener/webpack-loader" }],
      },
    ],
  },
};
```

The loader emits JavaScript, so that rule stands on its own. Pass
`options.emit: "typescript"` when a loader after this one should strip the
types instead — to control its target, or for a host like Turbopack that is
told to expect TypeScript.

For Next/Turbopack, add a `turbopack.rules["*.sts"]` loader rule with
`as: "*.ts"`. Use a separate Sweetener project configuration if Next's own
TypeScript checker owns `tsconfig.json`, and provide declarations for runtime
exports imported from `.sts` modules.

## Importing a macro module from ordinary TypeScript

`tsc` does not know what a `.sts` is, so `import { pair } from "./main.sts"` in
a `.ts` or `.tsx` file is unresolvable — which breaks the build script a Vite
app ships with, `tsc -b && vite build`. Turn on source declarations:

```json
{
  "compilerOptions": { "allowArbitraryExtensions": true },
  "sweet": { "sourceDeclarations": true },
  "files": ["src/macros.sts", "src/main.sts"]
}
```

`sweetener build` then writes `src/main.d.sts.ts` beside each source, which is
the name TypeScript resolves `./main.sts` through. Real types cross the
boundary: assigning a `readonly number[]` export to a `string` is an error in
plain `tsc`, and editors report it too, because they are running the same
compiler. Add `*.d.sts.ts` and `*.d.stsx.ts` to `.gitignore`.

This replaces hand-written `declare module "*.sts"` blocks, which have to
restate every export and go stale silently.

## Parcel

`@sweetener/parcel-transformer` is a Parcel 2 transformer. It hands the asset
back as `ts`/`tsx`, so Parcel's own pipeline finishes the job:

```json
{
  "extends": "@parcel/config-default",
  "transformers": { "*.sts": ["@sweetener/parcel-transformer", "..."] }
}
```

A `.sweetenerrc` or a `sweetener` key in `package.json` can name the project
config.

The transformer's entry point is CommonJS, and deliberately so. Parcel loads a
CommonJS plugin through a `require` it has patched, so it sees each dependency
as the plugin asks for it. An ES module plugin is loaded with `import()`, which
Parcel cannot intercept, so it parses the plugin's whole module graph up front
instead — and this plugin's graph reaches the TypeScript compiler, whose bundle
calls `require` on paths it computes at runtime. Parcel used to report that as
"contains non-statically analyzable dependencies in its module graph" and throw
away its cache at every startup. A CommonJS entry is never analyzed, so both
that warning and the cache loss are gone, and so is Parcel's separate warning
that ES module plugins are experimental. The compiler itself is still an ES
module; the transformer reaches it with `import()` on the first file it
expands.

## Jest

`@sweetener/jest` is an asynchronous ESM transformer with dependency-aware
cache keys, so editing a macro re-expands the files that import it:

```js
// jest.config.mjs
export default {
  transform: { "\\.stsx?$": ["@sweetener/jest", {}] },
  moduleFileExtensions: ["sts", "stsx", "js", "ts", "json"],
  extensionsToTreatAsEsm: [".sts", ".stsx"],
};
```

Run Jest with `NODE_OPTIONS=--experimental-vm-modules`.

## Other native integrations

- **There is no Babel integration**, and there cannot be a Babel plugin:
  expansion has to happen before Babel parses, and a `parserOverride` returning
  an AST built from different text would leave every source-map position
  pointing into the expansion. Under babel-loader use
  `@sweetener/webpack-loader`; in place of babel-jest use `@sweetener/jest`,
  which runs Babel itself and passes the expansion's map as Babel's input map
  so the result still names the `.sts`.
- `@sweetener/node/register` installs Node module customization hooks, expands
  `.sts`, strips TypeScript with the official compiler, and executes it as ESM.
  Emitted JavaScript carries a composed inline source map, so
  `--enable-source-maps` reports stack frames at their `.sts` lines.
- `@sweetener/cli` and `@sweetener/compiler` remain the full-project TypeScript
  check/build/declaration path. Emitted `.js.map` and `.d.ts.map` are composed
  against the expansion, so they name the `.sts` and carry its text.

Tools such as Turborepo, Nx, Storybook, Electron, tsup, and unbuild orchestrate
or embed one of the verified hosts above; select the adapter for their chosen
builder. SWC and Oxc AST plugins cannot parse arbitrary Sweetener syntax, so
Sweetener must run before them.

## Test policy

Adapters are tested against real host APIs, not only mocked hook objects. The
suite covers production output, compile-time import removal, source maps where
the host exposes them, macro dependency registration, macro-only incremental
rebuilds, and direct runtime execution. Versions are pinned in each adapter's
development dependencies to make the compatibility claim reproducible.
