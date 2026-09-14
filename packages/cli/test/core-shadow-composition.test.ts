import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

describe("core-shadow composition", () => {
  test("expands statement, expression, and JSX-child macros inside #core function bodies", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-core-composition-"));
    writeFileSync(
      join(directory, "forms.sts"),
      `export syntax function:item shadows core {
         rule { function $name:binding $parameters:tt $body:stmt }
         bind $name in following as recursive value;
         => { #core(function $name $parameters $body) }
       }`,
    );
    writeFileSync(
      join(directory, "body.stsx"),
      `export syntax trace:stmt {
         rule { trace $value:expr; } => { globalThis.console.log($value); }
       }
       export syntax doubled:expr {
         rule { doubled($value:expr) } => { $value + $value }
       }
       export syntax badge:jsxChild {
         rule { {badge ($value:expr)} } => { <strong>{$value}</strong> }
       }`,
    );
    writeFileSync(
      join(directory, "jsx-runtime.ts"),
      `export declare function h(...values: unknown[]): unknown;
       export declare const Fragment: unique symbol;
       declare global {
         namespace JSX {
           interface IntrinsicElements {
             div: Record<string, unknown>;
             strong: Record<string, unknown>;
           }
         }
       }`,
    );
    writeFileSync(
      join(directory, "main.stsx"),
      `import { h, Fragment } from "./jsx-runtime.js";
       import { function } from "./forms.sts" for syntax shadows core;
       import { trace, doubled, badge } from "./body.stsx" for syntax;

       function Component() {
         trace "inside";
         const value = doubled(2);
         return <div>{badge (value)}</div>;
       }

       export const rendered = Component();`,
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react",
          jsxFactory: "h",
          jsxFragmentFactory: "Fragment",
        },
        sweet: { macroExtensions: [".sts", ".stsx"] },
        files: ["jsx-runtime.ts", "forms.sts", "body.stsx", "main.stsx"],
      }),
    );

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: join(directory, "tsconfig.json"),
      writeThrough: false,
    });
    expect(
      result.diagnostics.map(({ code, messageText }) => ({
        code,
        messageText,
      })),
    ).toEqual([]);
    const generated = result.virtualFiles.find(({ fileName }) =>
      fileName.endsWith("main.tsx"),
    )?.generated.text;
    expect(generated).toBeDefined();
    expect(generated).toContain('globalThis.console.log("inside")');
    expect(generated).toMatch(/const value = \(2 \+\s*2\)/u);
    expect(generated).toContain("<strong>{value}</strong>");
    expect(generated).not.toContain("trace");
    expect(generated).not.toContain("doubled");
    expect(generated).not.toContain("badge");
  });

  test("merges same-module imports and delegates the complete function grammar", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-core-functions-"));
    writeFileSync(
      join(directory, "implementation.sts"),
      `export syntax coreItem:item {
         rule { coreItem $declaration:tt }
         => { #core($declaration) }
       }`,
    );
    writeFileSync(
      join(directory, "public.sts"),
      `import { coreItem } from "./implementation.sts" for syntax;
       export syntax marker:expr {
         rule { marker } => { 42 }
       }
       export syntax function:item shadows core {
         fallback rule { $declaration:tt }
         => { coreItem $declaration }
       }`,
    );
    writeFileSync(
      join(directory, "main.sts"),
      `import { marker } from "./public.sts" for syntax;
       import { function } from "./public.sts" for syntax shadows core;

       function generic<T>(value: T): T { return value; }
       async function asynchronous(): Promise<number> { return marker; }
       function* generator(): Generator<number> { yield marker; }
       function overloaded(value: string): string;
       function overloaded(value: number): number;
       function overloaded(value: string | number): string | number { return value; }
       export default function namedDefault(): number { return marker; }
       export const answer = generic(marker);`,
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        sweet: { macroExtensions: [".sts"] },
        files: ["implementation.sts", "public.sts", "main.sts"],
      }),
    );

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: join(directory, "tsconfig.json"),
      writeThrough: false,
    });
    expect(
      result.diagnostics.map(({ code, messageText }) => ({
        code,
        messageText,
      })),
    ).toEqual([]);
    const generated = result.virtualFiles.find(({ fileName }) =>
      fileName.endsWith("main.ts"),
    )?.generated.text;
    expect(generated).toBeDefined();
    expect(generated).toContain("function generic<T>");
    expect(generated).toContain("async function asynchronous()");
    expect(generated).toContain("function* generator()");
    expect(generated).toContain("function overloaded(value: string): string;");
    expect(generated).toContain("export default function namedDefault()");
    expect(generated?.match(/42/gu)).toHaveLength(4);
    expect(generated).not.toContain("marker");
    expect(generated).not.toContain("for syntax");
  });
});
