# Sweetener Playground

The browser playground runs the production Sweetener expansion provider in
a Web Worker over an in-memory project filesystem. It does not use a server,
saved output, or a fallback transformer.

From the repository root:

```bash
pnpm playground
```

Open `http://localhost:4173`.

## Loading a GitHub Gist

Open `#/gist/<gist-id>` directly, or paste a public Gist URL or ID into the
playground toolbar. A playground Gist contains a `sweetener-playground.json`
manifest and one or more source files:

```json
{
  "version": 1,
  "name": "My macro",
  "summary": "What the project demonstrates.",
  "entryFileName": "main.sts"
}
```

Source filenames must be flat, safe names ending in `.sts`, `.stsx`, `.ts`,
`.tsx`, or `.d.ts`. The loader accepts at most 32 files, 256 KiB per file, and
512 KiB for the project. It rejects truncated files and never executes Gist
JavaScript; sources are only passed to the sandboxed browser compiler.

The example selector loads eleven macro families: eight from the production
acceptance suite, and three written against `effect` and `zod` that are read
from `examples/library-macros`, where CI type-checks them against the real
libraries. Both `macros.sts` and `main.sts` are editable;
every edit recompiles the complete virtual project and updates the generated
TypeScript or real compiler diagnostics.

Build and exercise every example through the generated browser worker:

```bash
pnpm playground:build
```
