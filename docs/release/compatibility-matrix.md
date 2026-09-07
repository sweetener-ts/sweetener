# Supported toolchain compatibility matrix

Date: 2026-09-07

## Declared support

- Node.js: `>=24`
- TypeScript compiler API: `6.0.x`
- Published compatibility-package endpoints tested: `6.0.0` and `6.0.2`

The npm package versions `@typescript/typescript6@6.0.0` and `6.0.2` both
currently expose compiler API version `6.0.3`. Package version and runtime API
version are recorded separately because they are not interchangeable.

## Matrix

| Node    | Compatibility package | API reported | Reader/scanner | Compiler host | Language service |
| ------- | --------------------- | ------------ | -------------- | ------------- | ---------------- |
| 24.0.0  | 6.0.0                 | 6.0.3        | pass           | pass          | pass             |
| 24.0.0  | 6.0.2                 | 6.0.3        | CI matrix      | CI matrix     | CI matrix        |
| 24.18.1 | 6.0.0                 | 6.0.3        | CI matrix      | CI matrix     | CI matrix        |
| 24.18.1 | 6.0.2                 | 6.0.3        | pass           | pass          | pass             |
| 26.5.0  | 6.0.0                 | 6.0.3        | CI matrix      | CI matrix     | CI matrix        |
| 26.5.0  | 6.0.2                 | 6.0.3        | CI matrix      | CI matrix     | CI matrix        |

The oldest combined endpoint passed 27 focused tests covering the scanner and
lexical modes, virtual compiler checking/emission/imports, and mutable virtual
language-service snapshots. The newest combined endpoint also produced the
complete benchmark suite and passes the ordinary repository gate. The GitHub
Actions compatibility workflow runs the full cross product on every pull
request and main-branch push.

## Adapter differences

No token-kind, span, parser, compiler-host, module-resolution, diagnostic, or
language-service differences were observed between compatibility package 6.0.0
and 6.0.2. Both expose API version 6.0.3, so the scanner adapter intentionally
checks the `6.0.x` API line rather than the npm package patch.

TypeScript 7.0 remains unsupported because it has no compatible programmatic API
for this host. Node 26 is outside the supported LTS line. The public toolchain
probe returns stable diagnostics:

- `SWR7001` for an unsupported or malformed Node version;
- `SWR7002` for an unsupported TypeScript API version.

`pnpm compatibility:probe` succeeds only when both versions are supported.
