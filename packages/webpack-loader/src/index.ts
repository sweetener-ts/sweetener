import {
  createSweetenerSession,
  describeDiagnostics,
  stripTypes,
} from "@sweetener/compiler";
import type { LoaderContext } from "webpack";

export interface SweetenerLoaderOptions {
  readonly configFile?: string | undefined;
  /**
   * What to hand the next step in the chain. Defaults to `"javascript"`.
   *
   * Expansion produces TypeScript, and webpack's own parser cannot read it:
   * the documented single-loader rule failed on the first annotated
   * declaration with `Module parse failed: Unexpected token`, which names
   * neither Sweetener nor types. Stripping here is what makes that rule work
   * on its own. Choose `"typescript"` when a loader after this one should do
   * the stripping — to control its target, or because the host, like
   * Turbopack's `as: "*.ts"`, is expecting TypeScript.
   */
  readonly emit?: "javascript" | "typescript" | undefined;
}

const sessions = new WeakMap<
  object,
  ReturnType<typeof createSweetenerSession>
>();

function sessionFor(context: LoaderContext<SweetenerLoaderOptions>) {
  const owner = (context._compiler as object | undefined) ?? context;
  const existing = sessions.get(owner);
  if (existing !== undefined) return existing;
  const session = createSweetenerSession();
  sessions.set(owner, session);
  return session;
}

export default function sweetenerLoader(
  this: LoaderContext<SweetenerLoaderOptions>,
  source: string,
): void {
  const callback = this.async();
  const options = this.getOptions?.() ?? {};
  void sessionFor(this)
    .transform({
      code: source,
      filename: this.resourcePath,
      configFile: options.configFile,
      mode: this.mode === "production" ? "production" : "development",
    })
    // `.then(onFulfilled, onRejected)` only catches a rejection of the promise
    // before it, so a throw from inside the success branch escaped as an
    // unhandled rejection with the callback never called — which takes the
    // whole dev server down rather than reporting a macro error.
    .then((result) => {
      for (const dependency of result.dependencies)
        this.addDependency(dependency);
      if (result.diagnostics.length > 0) {
        callback(new Error(describeDiagnostics(result.diagnostics)));
        return;
      }
      const emitted =
        options.emit === "typescript"
          ? { code: result.code, map: undefined }
          : stripTypes(result, {
              filename: this.resourcePath,
              configFile: options.configFile,
            });
      const map = emitted.map ?? result.map;
      callback(null, emitted.code, {
        ...map,
        file: map.file ?? result.virtualFilename,
        sources: [...map.sources],
        sourcesContent: (map.sourcesContent ?? []).map(
          (content) => content ?? "",
        ),
        names: [...map.names],
      });
    })
    .catch((error: unknown) =>
      callback(error instanceof Error ? error : new Error(String(error))),
    );
}
