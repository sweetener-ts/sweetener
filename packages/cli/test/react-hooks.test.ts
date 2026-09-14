import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
  runConfiguredProjectCommand,
} from "../src/index.js";

const exampleConfig = resolve(
  import.meta.dirname,
  "../../../examples/vite-react/sweetener.json",
);

describe("React hook macro project", () => {
  test("checks bindings, collisions, async callbacks, cleanup, and runtime imports", () => {
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: exampleConfig,
      writeThrough: false,
    });
    expect(result.diagnostics).toEqual([]);
    const generated = result.virtualFiles.find(({ fileName }) =>
      fileName.endsWith("main.tsx"),
    )?.generated.text;
    expect(generated).toBeDefined();
    expect(generated).toContain("useState<number>");
    expect(generated).toContain("setCount((value)");
    expect(generated).toContain("toggleDetailsOpen");
    expect(generated).toContain("useDeferredValue");
    expect(generated).toContain("useId()");
    expect(generated).toContain("setPage");
    expect(generated).toContain("setQuery");
    expect(generated).toContain("latestStep");
    expect(generated).toContain("navigationPending");
    expect(generated).toContain("startNavigation");
    expect(generated).not.toContain("consttoggleDetailsOpen");
    expect(generated).toContain("useCallback(async");
    expect(generated).toContain("return () =>");
    expect(generated).toContain('from "react"');
    expect(generated).not.toContain("for syntax");
  });

  test("maps a generated hook type error to the captured STSX initializer", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-react-diagnostic-"));
    const macros = join(directory, "hooks.sts");
    const runtime = join(directory, "runtime.ts");
    const input = join(directory, "component.stsx");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      runtime,
      "export declare function useState<T>(value: T): [T, (value: T) => void];\n",
    );
    writeFileSync(
      macros,
      `import { useState } from "./runtime.js";
       export syntax state:stmt {
         rule { state $value:binding: $valueType:type = $initial:expr; }
         bind $value in following as lexical value;
         bind #join($value, prefix: "set", casing: "upper-first") in following as lexical value;
         => { const [$value, #join($value, prefix: "set", casing: "upper-first")] = useState<$valueType>($initial); }
       }`,
    );
    const inputSource = `import { state } from "./hooks.sts" for syntax;
       export function Broken() {
         state count: number = "wrong";
         return setCount(count);
       }`;
    writeFileSync(input, inputSource);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
        },
        sweet: { macroExtensions: [".sts", ".stsx"] },
        files: ["runtime.ts", "hooks.sts", "component.stsx"],
      }),
    );
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    const mismatch = result.diagnostics.find(({ code }) => code === 2345);
    expect(mismatch?.file?.fileName).toBe(input);
    const initializerStart = inputSource.indexOf('"wrong"');
    expect(mismatch?.start).toBeGreaterThanOrEqual(initializerStart);
    expect(mismatch?.start).toBeLessThan(initializerStart + '"wrong"'.length);
  });

  test("expands identically named state bindings in separate component scopes", () => {
    const provider = createDefaultProjectExpansionProvider();
    const project = loadSweetProject(exampleConfig);
    const expansion = provider.expandProject(project);
    expect(expansion.diagnostics).toEqual([]);
  });
});
