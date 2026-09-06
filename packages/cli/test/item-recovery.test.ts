import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * An item the enforester cannot consume must not be passed through in silence.
 *
 * The item loop used to fall back to swallowing raw syntax up to the next
 * top-level `;` and protecting it as an opaque item. A bare `import "./x"`
 * with no semicolon took that path, and because the only remaining semicolons
 * were nested inside a following declaration's braces, the fallback consumed
 * the rest of the file. Every macro invocation in it was emitted verbatim,
 * the expansion reported no diagnostics at all, and every adapter built the
 * result happily — so a bundle shipped calling a macro that no longer existed.
 *
 * Two things have to hold. Recovery has to stop at the item boundary the
 * reader already knows about rather than hunting for a semicolon, so ordinary
 * semicolon-free code expands. And when recovery really does give up, it has
 * to say so.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}
`;

interface Expansion {
  readonly generated: string;
  readonly diagnostics: readonly string[];
}

function expand(source: string, extension = "sts"): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-recovery-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, `main.${extension}`), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: false,
        target: "ES2022",
        jsx: "react-jsx",
      },
      sweet: { macroExtensions: [".sts", ".stsx"] },
      files: ["macros.sts", `main.${extension}`],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  const suffix = extension === "stsx" ? "main.tsx" : "main.ts";
  const generated = expanded.files.find(({ fileName }) =>
    fileName.endsWith(suffix),
  )?.generated.text;
  if (generated === undefined)
    throw new Error(`main.${extension} produced no output`);
  return {
    generated,
    diagnostics: expanded.diagnostics.map(({ messageText }) =>
      String(messageText),
    ),
  };
}

/** Ordinary TypeScript that happens to omit semicolons. It must expand. */
const semicolonFree: readonly (readonly [string, string])[] = [
  [
    "a bare import with no semicolon before a function",
    `import { twice } from "./macros.sts" for syntax;
import "./side"
export function f() { return twice(1); }
`,
  ],
  [
    "a bare import with no semicolon before a class",
    `import { twice } from "./macros.sts" for syntax;
import "./side"
export class C { m() { return twice(1); } }
`,
  ],
  [
    "a bare import with no semicolon before a multi-line function",
    `import { twice } from "./macros.sts" for syntax;
import "./side"

export function f() {
  const a = 1;
  return twice(a);
}
`,
  ],
  [
    "a file with no semicolons at all",
    `import { twice } from "./macros.sts" for syntax;
import "./side"

const a = 1
const b = twice(a)

export function f() {
  return b
}
`,
  ],
  [
    "the import prologue of the default Vite React template",
    `import { useState } from 'react'
import { twice } from './macros.sts' for syntax;
import viteLogo from './assets/vite.svg'
import './App.css'

function App() {
  const [count] = useState(0)
  const dup = twice(count)
  return dup
}

export default App
`,
  ],
];

describe("item recovery", () => {
  for (const [description, source] of semicolonFree) {
    test(`expands ${description}`, () => {
      const { generated, diagnostics } = expand(source);
      expect(diagnostics).toEqual([]);
      expect(generated).not.toContain("twice(");
    });
  }

  test("expands the Vite template prologue in a .stsx file", () => {
    const { generated, diagnostics } = expand(
      `import { twice } from './macros.sts' for syntax;
import './App.css'

function App() {
  const dup = twice(1)
  return <div>{dup}</div>
}

export default App
`,
      "stsx",
    );
    expect(diagnostics).toEqual([]);
    expect(generated).not.toContain("twice(");
  });

  /** Recovery ends at the next item, rather than eating the rest of the file. */
  test("an unreadable item does not stop the items after it expanding", () => {
    const { generated, diagnostics } = expand(
      `import { twice } from "./macros.sts" for syntax;
)
export const a = twice(1);
export function f() { return twice(2); }
`,
    );
    expect(generated).not.toContain("twice(");
    expect(diagnostics.join("\n")).toContain("Unexpected");
  });

  /** When recovery does swallow an invocation, it has to say so. */
  test("reports a macro left unexpanded by recovery", () => {
    const { generated, diagnostics } = expand(
      `import { twice } from "./macros.sts" for syntax;
) twice(1);
`,
    );
    expect(generated).toContain("twice(");
    expect(diagnostics.join("\n")).toContain(
      "Sweetener could not read this item, so twice in it was left unexpanded",
    );
  });

  /**
   * The invariant itself. Whatever recovery does with syntax it cannot
   * enforest, it may never leave an invocation of a macro that is in scope
   * sitting in the output while reporting nothing.
   */
  test("never emits an unexpanded invocation without a diagnostic", () => {
    const sources = [
      ...semicolonFree.map(([, source]) => source),
      `import { twice } from "./macros.sts" for syntax;
export const a = twice(1);
export function f() { return twice(2); }
`,
      `import { twice } from "./macros.sts" for syntax;
) twice(1);
`,
      `import { twice } from "./macros.sts" for syntax;
+ + + twice(1)
`,
      `import { twice } from "./macros.sts" for syntax;
export const o = { ) twice(1) };
`,
    ];
    for (const source of sources) {
      const { generated, diagnostics } = expand(source);
      if (generated.includes("twice("))
        expect(
          diagnostics,
          `unexpanded invocation reported nothing for:\n${source}`,
        ).not.toEqual([]);
    }
  });
});
