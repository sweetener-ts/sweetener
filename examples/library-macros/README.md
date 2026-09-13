# Library macros

Macros written against a third-party library, kept out of the language tour
because the tour is self-contained and these need real packages to type-check.

- `zod-schema` — one type declaration emits both the interface and the zod
  schema that validates it, ending in `satisfies z.ZodType<T>` so TypeScript
  checks the derivation rather than trusting it.
- `effect-service` — `service` and `error` emit the `Context.Tag` class, the
  shape interface, one accessor per method, and the layer helper.
- `effect-do` — `gen`, `effect` and `handle`: binds written `name <- effect`,
  with no `Effect<A, E, R>` written anywhere.
