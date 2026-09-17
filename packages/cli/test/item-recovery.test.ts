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
 * A fallback that swallows raw syntax up to the next top-level `;` and
 * protects it as an opaque item fails badly on a bare `import "./x"` with no
 * semicolon: when the only remaining semicolons are nested inside a following
 * declaration's braces, it consumes the rest of the file. Every macro
 * invocation in it is emitted verbatim, the expansion reports no diagnostics
 * at all, and every adapter builds the result happily — so a bundle ships
 * calling a macro that does not exist at run time.
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

export syntax member:typeMember {
  rule { member } => { readonly at: number; }
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

  /**
   * When recovery does swallow an invocation, it has to say so. A member macro
   * written at the top of a file is one: a member list is the only place it
   * reads, so nothing the walk asks about the position finds it and nothing
   * else reports it.
   */
  test("reports a macro left unexpanded by recovery", () => {
    const { generated, diagnostics } = expand(
      `import { member } from "./macros.sts" for syntax;
) member;
`,
    );
    expect(generated).toContain("member");
    expect(diagnostics.join("\n")).toContain(
      "Sweetener could not read this item, so member in it was left unexpanded",
    );
  });

  /**
   * An interface body recovery swallowed is still a member list. The walk can
   * place a member macro written in one, so it expands there as it would in an
   * interface the reader took whole.
   */
  test("expands a member macro in an interface recovery swallowed", () => {
    const { generated, diagnostics } = expand(
      `import { member } from "./macros.sts" for syntax;
) interface I { member; }
`,
    );
    expect(generated).toContain("readonly at: number;");
    expect(diagnostics.join("\n")).not.toContain(
      "Sweetener could not read this item",
    );
  });

  /**
   * A statement recovery swallowed is still a statement, and an expression
   * macro standing as one is dispatched there as it would be anywhere else.
   */
  test("expands an invocation recovery swallowed but the walk could place", () => {
    const { generated, diagnostics } = expand(
      `import { twice } from "./macros.sts" for syntax;
) twice(1);
`,
    );
    expect(generated).not.toContain("twice(");
    expect(diagnostics.join("\n")).not.toContain(
      "Sweetener could not read this item",
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
