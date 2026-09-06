import type { RawSourceMap } from "@sweetener/typescript-host";
import * as ts from "typescript";
import {
  discoverSweetConfig,
  type SweetenerTransformResult,
} from "./session.js";
import { loadSweetProject } from "./configuration.js";

export interface StrippedOutput {
  readonly code: string;
  /** Absent when the two stages' maps could not be composed. */
  readonly map: RawSourceMap | undefined;
}

/**
 * Turn expanded TypeScript into JavaScript, for a host that has none.
 *
 * Expansion emits TypeScript. Vite runs its own Oxc transform, and esbuild and
 * Bun are told which loader to read the output with, so those three take it
 * from here. Rollup, Rolldown, webpack and Rspack have no TypeScript at all,
 * and handing them `export const x: T = ...` produced errors naming neither
 * Sweetener nor types — `'const' declarations must be initialized` — because
 * the annotation is where their JavaScript parser gave up.
 *
 * The compiler options come from the Sweetener project rather than the host:
 * they are the ones that governed the `.sts`. Module format is forced to ESM
 * because every host that needs this bundles, and handing one CommonJS would
 * defeat that.
 */
export function stripTypes(
  expanded: SweetenerTransformResult,
  options: {
    readonly filename: string;
    readonly configFile?: string | undefined;
  },
): StrippedOutput {
  const projectOptions = ((): ts.CompilerOptions => {
    try {
      return loadSweetProject(
        options.configFile ?? discoverSweetConfig(options.filename),
      ).typescript.options;
    } catch {
      // No config to find, or one that will not load. Stripping types with
      // defaults still beats handing the host TypeScript it cannot read.
      return {};
    }
  })();
  // A `.stsx` in a project with no `jsx` setting would otherwise emit its JSX
  // untouched, which the host can read no better than the types.
  const jsx =
    projectOptions.jsx ??
    (expanded.virtualFilename.endsWith("x") ? ts.JsxEmit.ReactJSX : undefined);
  const emitted = ts.transpileModule(expanded.code, {
    fileName: expanded.virtualFilename,
    compilerOptions: {
      ...projectOptions,
      ...(jsx === undefined ? {} : { jsx }),
      module: ts.ModuleKind.ESNext,
      sourceMap: true,
      inlineSourceMap: false,
      inlineSources: false,
      declaration: false,
      declarationMap: false,
    },
  });
  let composed: RawSourceMap | undefined;
  if (emitted.sourceMapText !== undefined)
    try {
      composed = expanded.composeMap(
        JSON.parse(emitted.sourceMapText) as RawSourceMap,
      );
    } catch {
      composed = undefined;
    }
  return {
    // TypeScript appends a comment naming a `.map` beside a file that does not
    // exist. The host takes the map from the return value instead.
    code: emitted.outputText.replace(/\n\/\/# sourceMappingURL=.*$/u, "\n"),
    map: composed,
  };
}
