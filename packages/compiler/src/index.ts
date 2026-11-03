import * as typescript from "typescript";

export const packageName = "@sweetener/compiler" as const;
export * from "./configuration.js";
export * from "./describe-diagnostics.js";
export * from "./default-expansion-provider.js";
export * from "./expansion-inputs.js";
export * from "./expansion-tools.js";
export * from "./project-command.js";
export * from "./session.js";
export * from "./source-kind.js";
export * from "./strip-types.js";
export * from "./unresolved-names.js";
// The TypeScript the compiler runs on, for a package that has to use the same
// one where its project's `typescript` is another: a second copy costs its load.
export { typescript };
