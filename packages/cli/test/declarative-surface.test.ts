import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  /** Exactly what was printed, for assertions about layout. */
  readonly raw: string;
  readonly messages: readonly string[];
}

function expand(
  macros: string,
  main: string,
  jsx?: { readonly runtime: string },
): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-surface-"));
  const entry = jsx === undefined ? "main.sts" : "main.stsx";
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, entry), main);
  if (jsx !== undefined) {
    writeFileSync(join(directory, "jsx-runtime.ts"), jsx.runtime);
  }
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        ...(jsx === undefined
          ? {}
          : {
              jsx: "react",
              jsxFactory: "h",
              jsxFragmentFactory: "Fragment",
            }),
      },
      sweet: { macroExtensions: [".sts", ".stsx"] },
      files: [
        ...(jsx === undefined ? [] : ["jsx-runtime.ts"]),
        "macros.sts",
        entry,
      ],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith(jsx === undefined ? "main.ts" : "main.tsx"),
  )?.generated.text;
  if (generated === undefined) throw new Error(`${entry} was not expanded`);
  return {
    text: generated.replaceAll(/\s+/gu, " ").trim(),
    raw: generated,
    messages: result.diagnostics.map(({ messageText }) => String(messageText)),
  };
}

/** Runs one exported binding out of an expansion, to check what it computes. */
function evalExport(generated: string, name: string): unknown {
  const body = generated
    .replaceAll(/^\s*import[^;]*;/gmu, "")
    .replaceAll(/\bexport\s+/gu, "")
    .replaceAll(/:\s*(?:readonly\s+)?[A-Za-z_][\w.<>[\]|]*/gu, "");
  return new Function(`${body}; return ${name};`)();
}

describe("optional captures", () => {
  test("give an empty sequence to a template repetition when absent", () => {
    const { text } = expand(
      `export syntax atLeast:expr {
         rule { atLeast($($bound:expr)?) } => { [true $(&& $bound)*] }
       }`,
      `import { atLeast } from "./macros.sts" for syntax;
       declare const size: number;
       export const none = atLeast();
       export const some = atLeast(size > 0);`,
    );
    expect(text).toContain("export const none = [true]");
    expect(text).toContain("export const some = [true && (size > 0)]");
  });

  test("answer #if(present) rather than failing when absent", () => {
    const { text } = expand(
      `export syntax atLeast:expr {
         rule { atLeast($($bound:expr)?) } => {
           [#if(present $bound) { $($bound)* } #else { true }]
         }
       }`,
      `import { atLeast } from "./macros.sts" for syntax;
       declare const size: number;
       export const none = atLeast();
       export const some = atLeast(size > 0);`,
    );
    expect(text).toContain("export const none = [true]");
    expect(text).toContain("export const some = [size > 0]");
  });

  test("let a syntax class declare a field a rule may omit", () => {
    const { text, messages } = expand(
      `export syntax class Arm {
         fields {
           pattern: tt;
           guard: expr?;
           body: expr;
         }

         rule { $pattern:tt if ($guard:expr) => $body:expr }
         rule { $pattern:tt => $body:expr }
       }

       export syntax arms:expr {
         rule { arms { $($arm:Arm),+ } } => {
           [$([$arm.body, #if(present $arm.guard) { $arm.guard } #else { true }]),*]
         }
       }`,
      `import { arms } from "./macros.sts" for syntax;
       declare const size: number;
       export const table = arms { _ => 1, 2 if (size > 0) => 3 };`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("[[1, true], [3, size > 0]]");
  });
});

describe("declarative surface", () => {
  test("accepts a contextual keyword where an identifier is expected", () => {
    // TypeScript scans `type` as a keyword, but it is an ordinary identifier in
    // a property position, which is where discriminated unions put it.
    const { text } = expand(
      `export syntax fieldName:expr {
         rule { fieldName($subject:expr, $name:ident) } => {
           ($subject)[#text($name)]
         }
       }`,
      `import { fieldName } from "./macros.sts" for syntax;
       declare const event: Record<string, unknown>;
       export const kind = fieldName(event, type);
       export const other = fieldName(event, plain);`,
    );
    expect(text).toContain('(event)["type"]');
    expect(text).toContain('(event)["plain"]');
  });

  test("separates a template keyword from the capture that follows it", () => {
    const { text, messages } = expand(
      `export syntax kindOf:expr {
         rule { kindOf($value:expr) } => { typeof $value }
       }`,
      `import { kindOf } from "./macros.sts" for syntax;
       const event = 1;
       export const named = kindOf(event);`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("typeof event");
  });

  test("lets a rule expand to nothing", () => {
    const { text, messages } = expand(
      `export syntax erase:stmt {
         rule { erase($value:expr); } => { }
       }`,
      `import { erase } from "./macros.sts" for syntax;
       export function run(): number {
         const kept = 1;
         erase(kept);
         return kept;
       }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("const kept = 1; ; return kept;");
  });

  test("claims a macro extent that reaches past the expression", () => {
    // `block (x) { ... }` ends with a brace an ordinary expression parse would
    // leave behind as a separate statement.
    const macros = `export syntax block:expr {
         rule { block ($value:expr) { $($step:expr),+ } } => {
           [$value $(, $step)+]
         }
       }`;
    const { text, messages } = expand(
      macros,
      `import { block } from "./macros.sts" for syntax;
       declare const seed: number;
       export function run(): number[] {
         return block (seed) { 1, 2 };
       }
       export function keep(): number[] {
         const held = block (seed) { 3 };
         return held;
       }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return [seed, 1, 2]");
    expect(text).toContain("const held = [seed, 3]");
  });

  test("does not put a line break between return and its expression", () => {
    const { text, messages } = expand(
      // The template body starts on its own line in the definition.
      `export syntax wrapped:expr {
         rule { wrapped($value:expr) } => {
           [$value]
         }
       }`,
      `import { wrapped } from "./macros.sts" for syntax;
       export function run(): number[] {
         return wrapped(1);
       }`,
    );
    expect(messages).toEqual([]);
    // A newline here would end the statement and return undefined.
    expect(text).toContain("return [1]");
  });

  test("reports a rule whose template does not compile and expands nothing", () => {
    const { text, messages } = expand(
      // `$bound` is a sequence, so reading it outside a repetition is an error.
      `export syntax broken:expr {
         rule { broken($($bound:expr)?) } => { [$bound] }
       }`,
      `import { broken } from "./macros.sts" for syntax;
       export const value = broken();`,
    );
    expect(messages).toContain("Capture $bound requires template depth 1.");
    // The invocation is left alone rather than expanding a template that
    // cannot be evaluated.
    expect(text).toContain("broken()");
  });
});

describe("JSX children", () => {
  const runtime = `export function h(
  tag: string,
  props: Readonly<Record<string, unknown>> | null,
  ...children: readonly unknown[]
): unknown {
  return { tag, props, children };
}
export const Fragment = "fragment";
declare global {
  namespace JSX {
    type Element = unknown;
    type ElementType = string;
    interface IntrinsicElements {
      readonly [tag: string]: unknown;
    }
  }
}`;

  test("dispatch a macro whose invocation spans several children", () => {
    const { text, messages } = expand(
      `export syntax each:jsxChild {
         rule { {each ($items:expr as $item:binding)} $body:jsxChild {end} }
         bind $item in $body as lexical value;
         => { {($items).map(($item) => $body)} }
       }`,
      `import { each } from "./macros.sts" for syntax;
       import { Fragment, h } from "./jsx-runtime.js";
       void h;
       void Fragment;
       export const list = (
         <ul>
           {each ([1, 2] as value)}
             <li>{value}</li>
           {end}
         </ul>
       );`,
      { runtime },
    );
    expect(messages).toEqual([]);
    // The head, the body, and the closing brace are one invocation.
    expect(text).toContain("([1, 2]).map((value) =>");
    expect(text).not.toContain("{end}");
  });

  test("expand an attribute value as an expression, not a child", () => {
    const { text, messages } = expand(
      `export syntax twice:expr {
         rule { twice($value:expr) } => { [$value, $value] }
       }`,
      `import { twice } from "./macros.sts" for syntax;
       import { Fragment, h } from "./jsx-runtime.js";
       void h;
       void Fragment;
       export const item = <li data={twice(1)}>{twice(2)}</li>;`,
      { runtime },
    );
    expect(messages).toEqual([]);
    // An attribute sits before the tag closes, so it is not a child.
    expect(text).toContain("data={[1, 1]}");
    expect(text).toContain(">{[2, 2]}<");
  });
});

describe("binder position", () => {
  const macros = `export syntax pair:binding {
       rule { pair($left:binding, $right:binding) } => { [$left, $right] }
     }
     export syntax boxed:binding {
       rule { boxed($name:binding) } => { { value: $name } }
     }`;

  test("dispatches a macro standing where a declaration names its binding", () => {
    const { text, messages } = expand(
      macros,
      `import { pair } from "./macros.sts" for syntax;
       declare const values: readonly number[];
       const pair(first, second) = values;
       export const total = first + second;
       export function inside(more: readonly number[]): number {
         let pair(third, fourth) = more;
         return third + fourth;
       }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("const [first, second] = values");
    expect(text).toContain("let [third, fourth] = more");
  });

  test("dispatches in a loop binder and a catch binder", () => {
    const { text, messages } = expand(
      macros,
      `import { pair } from "./macros.sts" for syntax;
       declare const rows: readonly (readonly number[])[];
       export function walk(): number {
         let total = 0;
         for (const pair(first, second) of rows) { total += first + second; }
         try { total += 1; } catch (pair(code, detail)) { total += 1; }
         return total;
       }`,
    );
    expect(messages.filter((message) => message.includes("SWR"))).toEqual([]);
    expect(text).toContain("for (const [first, second] of rows)");
    expect(text).toContain("catch ([code, detail])");
  });

  test("leaves an ordinary binder exactly as written", () => {
    const { text, messages } = expand(
      macros,
      `import { pair } from "./macros.sts" for syntax;
       export const plain = 1;
       export const { destructured } = { destructured: 2 };`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const plain = 1");
    expect(text).toContain("const { destructured } =");
  });

  test("renames what a binder macro introduces of its own", () => {
    const { text, messages } = expand(
      macros,
      `import { boxed } from "./macros.sts" for syntax;
       declare const source: { readonly value: number };
       const value = "call-site value";
       const boxed(held) = source;
       export const kept: readonly [string, number] = [value, held];`,
    );
    expect(messages).toEqual([]);
    // The property the macro writes keeps its spelling; the caller's binding
    // of the same name is untouched.
    expect(text).toContain("const { value: held } = source");
    expect(text).toContain('const value = "call-site value"');
  });
});

describe("macros calling macros", () => {
  test("expands an item macro written in another item macro's template", () => {
    const { text, messages } = expand(
      `export syntax helper:item {
         rule { helper $name:binding; }
         bind $name in following as lexical value;
         => { const $name = 7; }
       }
       export syntax pairOf:item {
         rule { pairOf $first:binding and $second:binding; }
         bind $first in following as lexical value;
         bind $second in following as lexical value;
         => {
           helper $first;
           helper $second;
         }
       }`,
      `import { pairOf } from "./macros.sts" for syntax;
       pairOf left and right;
       export const total = left + right;`,
    );
    expect(messages).toEqual([]);
    // The inner expansions come back already enforested, binder included.
    expect(text).toContain("const left = 7");
    expect(text).toContain("const right = 7");
  });

  test("expands a statement macro written in another statement macro's template", () => {
    const { text, messages } = expand(
      `export syntax note:stmt {
         rule { note $value:expr; } => { globalThis.console.log($value); }
       }
       export syntax notes:stmt {
         rule { notes $a:expr and $b:expr; } => {
           note $a;
           note $b;
         }
       }`,
      `import { notes } from "./macros.sts" for syntax;
       export function run(): void {
         notes 1 and 2;
       }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("globalThis.console.log(1)");
    expect(text).toContain("globalThis.console.log(2)");
  });
});

describe("template repetitions", () => {
  test("let an operation over a capture drive the repetition around it", () => {
    const { text, messages } = expand(
      `export syntax record:item {
         rule { record $name:binding { $($field:ident: $fieldType:type;)+ } }
         bind $name in following as recursive type;
         bind $name in following as recursive value;
         => {
           #core(interface $name {
             $($field: $fieldType;)+
           })
           #core(const $name = {
             fieldCount: #count($field),
             fields: [$(#text($field)),+],
           })
         }
       }`,
      `import { record } from "./macros.sts" for syntax;
       record Point {
         x: number;
         y: number;
       }
       export const meta = Point;`,
    );
    expect(messages).toEqual([]);
    // `#text($field)` is the only thing in the repetition, so it has to be
    // what drives it; `#count` reads the whole sequence and drives nothing.
    expect(text).toContain('fields: ["x", "y"]');
    expect(text).toContain("fieldCount: 2");
  });
});

describe("where an expansion lands", () => {
  test("puts a replacement where its invocation stood", () => {
    const { raw, messages } = expand(
      `export syntax two:item {
         rule { two; } => {
           #core(const first = 1)
           #core(const second = 2)
         }
       }`,
      `import { two } from "./macros.sts" for syntax;
       two;
       export const total = 0;`,
    );
    expect(messages).toEqual([]);
    // Neither the erased `#core` marker nor the invocation may swallow the
    // line break, or the two declarations run together and stop parsing.
    expect(raw).toMatch(/const first = 1\s*\n\s*const second = 2/u);
  });

  test("keeps a replacement on the line its invocation was on", () => {
    const { text, messages } = expand(
      `export syntax boxed:expr {
         rule { boxed($value:expr) } => {
           [$value]
         }
       }`,
      `import { boxed } from "./macros.sts" for syntax;
       export function run(): number[] {
         return boxed(1);
       }`,
    );
    expect(messages).toEqual([]);
    // A line break here would end the return statement.
    expect(text).toContain("return [1]");
  });
});

describe("expansions of more than one node", () => {
  test("expands a class element macro to several members", () => {
    const { text, messages } = expand(
      `export syntax withMembers:classElement {
         rule { withMembers { $($member:ident: $memberType:type),+ } } => {
           $(readonly $member: $memberType;)+
         }
       }`,
      `import { withMembers } from "./macros.sts" for syntax;
       export class Shape {
         withMembers { width: number, height: number }
         constructor(
           readonly width: number,
           readonly height: number,
         ) {}
       }`,
    );
    // A member list is a sequence like a statement or item list, and a macro
    // that fills one may emit more than a single member.
    expect(messages.filter((message) => message.includes("SWR"))).toEqual([]);
    expect(text).toContain("readonly width: number;");
    expect(text).toContain("readonly height: number;");
  });

  test("expands a JSX child macro to several children", () => {
    const runtime = `export function h(
  tag: string,
  props: Readonly<Record<string, unknown>> | null,
  ...children: readonly unknown[]
): unknown {
  return { tag, props, children };
}
export const Fragment = "fragment";
declare global {
  namespace JSX {
    type Element = unknown;
    type ElementType = string;
    interface IntrinsicElements {
      readonly [tag: string]: unknown;
    }
  }
}`;
    const { text, messages } = expand(
      `export syntax twice:jsxChild {
         rule { {twice} $body:jsxChild {end} } => {
           $body
           $body
         }
       }`,
      `import { twice } from "./macros.sts" for syntax;
       import { Fragment, h } from "./jsx-runtime.js";
       void h;
       void Fragment;
       export const doubled = (
         <ul>
           {twice}
             <li>x</li>
           {end}
         </ul>
       );`,
      { runtime },
    );
    expect(messages).toEqual([]);
    expect(text.match(/<li>x<\/li>/gu)).toHaveLength(2);
  });

  test("expands a type macro over a repetition", () => {
    const { text, messages } = expand(
      `export syntax matrix:type {
         rule { matrix<$($dimension:type),+> } => {
           globalThis.Array<[$($dimension),+]>
         }
       }`,
      `import { matrix } from "./macros.sts" for syntax;
       export const grid: matrix<number, string> = [[1, "a"]];`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("globalThis.Array<[number, string]>");
  });

  test("expands nested repetitions", () => {
    const { text, messages } = expand(
      `export syntax table:item {
         rule { table $name:binding { $($row:ident: [$($cell:expr),+];)+ } }
         bind $name in following as lexical value;
         => { const $name = { $($row: [$($cell),+],)+ }; }
       }`,
      `import { table } from "./macros.sts" for syntax;
       table Lookup {
         first: [1, 2, 3];
         second: [4, 5];
       }
       export const rows = Lookup;`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("first: [1, 2, 3]");
    expect(text).toContain("second: [4, 5]");
  });
});

describe("statement operators", () => {
  const macros = `export operator (<-):stmt {
       fixity infix;
       associativity none;
       precedence 20;
       rule { $name:binding <- $source:expr; }
       bind $name in following as lexical value;
       => { const $name = ($source); }
     }`;

  test("dispatches on its own, not only beside another operator", () => {
    const { text, messages } = expand(
      macros,
      `import { (<-) } from "./macros.sts" for syntax;
       export function run(): number {
         received <- 41;
         return received + 1;
       }`,
    );
    expect(messages).toEqual([]);
    // `received <- 41` also reads as `received < (-41)`, so the ordinary parse
    // must not commit before the operator is offered the statement.
    expect(text).toContain("const received =");
    expect(text).not.toContain("<-");
  });

  test("leaves an ordinary comparison against a negation alone", () => {
    const { text, messages } = expand(
      macros,
      `import { (<-) } from "./macros.sts" for syntax;
       declare const left: number;
       declare const right: number;
       export const smaller = left < -right;`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("left < -right");
  });
});

describe("where a macro may be written", () => {
  const macros = `export syntax twice:expr {
       rule { twice($value:expr) } => { [$value, $value] }
     }`;

  test("expands in every expression position", () => {
    const { text, messages } = expand(
      macros,
      `import { twice } from "./macros.sts" for syntax;
       export const inTemplate = \`pair: \${twice(1)}\`;
       export const inArray = [twice(2), 3];
       export const inObject = { key: twice(3) };
       export const inTernary = true ? twice(4) : twice(5);
       export const inSpread = [...twice(6)];
       export const inNested = twice(twice(7));
       export function inSwitch(value: number): number[] {
         switch (value) {
           case 1: return twice(8);
           default: return twice(9);
         }
       }
       export function inHeaders(values: number[]): void {
         for (const entry of twice(10)) { globalThis.console.log(entry); }
         while (twice(11).length > 0) { break; }
       }`,
    );
    expect(messages).toEqual([]);
    // A control-flow header holds an expression, the iterable of a `for`
    // included, so nothing may be left unexpanded anywhere here.
    expect(text).not.toContain("twice(");
  });

  test("expands in a computed property name and an export default", () => {
    const { text, messages } = expand(
      macros,
      `import { twice } from "./macros.sts" for syntax;
       export const keyed = { [globalThis.String(twice(1))]: 2 };
       export default twice(3);`,
    );
    expect(messages).toEqual([]);
    // A property name is not an expression, but a computed one holds one.
    expect(text).not.toContain("twice(");
    expect(text).toContain("export default [3, 3]");
  });

  test("leaves a plain property name alone", () => {
    const { text, messages } = expand(
      macros,
      `import { twice } from "./macros.sts" for syntax;
       export const named = { twice: 1 };`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("{ twice: 1 }");
  });

  test("expands after an equals sign, wherever it stands", () => {
    const { text, messages } = expand(
      macros,
      `import { twice } from "./macros.sts" for syntax;
       export function defaulted(value: number[] = twice(1)): number[] {
         return value;
       }
       export class Holder {
         field = twice(2);
         static shared = twice(3);
       }`,
    );
    expect(messages).toEqual([]);
    // A parameter default and a class field initializer are expressions even
    // though the syntax around them is a parameter list and a member list.
    expect(text).not.toContain("twice(");
    expect(text).toContain("value: number[] = [1, 1]");
    expect(text).toContain("field = [2, 2]");
    expect(text).toContain("static shared = [3, 3]");
  });

  test("leaves the loops it does not appear in alone", () => {
    const { text, messages } = expand(
      macros,
      `import { twice } from "./macros.sts" for syntax;
       export function loops(values: number[]): number {
         let total = 0;
         for (let index = 0; index < values.length; index += 1) {
           total += values[index]!;
         }
         for (const entry of values) { total += entry; }
         for (const key in { a: 1 }) { total += key.length; }
         return total;
       }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("for (let index = 0; index < values.length;");
    expect(text).toContain("for (const entry of values)");
    expect(text).toContain("for (const key in { a: 1 })");
  });
});

describe("type positions", () => {
  const macros = `export syntax boxed:type {
       rule { boxed<$inner:type> } => { globalThis.Array<$inner> }
     }`;

  test("expands wherever a type is written, not only in an annotation", () => {
    const { text, messages } = expand(
      macros,
      `import { boxed } from "./macros.sts" for syntax;
       export const annotated: boxed<number> = [1];
       export function returns(): boxed<string> { return ["a"]; }
       export function takes(value: boxed<number>): void {
         globalThis.console.log(value);
       }
       export type Alias = boxed<boolean>;
       export interface Holder { readonly field: boxed<number>; }
       export type Union = boxed<number> | undefined;
       export type Nested = globalThis.Map<string, boxed<number>>;
       export const asserted = [1] as boxed<number>;
       export function generic<T extends boxed<number>>(value: T): T {
         return value;
       }`,
    );
    expect(messages).toEqual([]);
    // A return type, a constraint, a union member, and the right-hand side of
    // a type alias are all types, however the syntax around them is walked.
    expect(text).not.toContain("boxed<");
  });

  test("expands in the remaining type positions", () => {
    const { text, messages } = expand(
      macros,
      `import { boxed } from "./macros.sts" for syntax;
       export type Conditional<T> = T extends string
         ? boxed<number>
         : boxed<string>;
       export type Tuple = readonly [boxed<number>, boxed<string>];
       export type Fn = (value: boxed<number>) => boxed<string>;
       export type Mapped = { readonly [K in "a" | "b"]: boxed<number> };`,
    );
    expect(messages).toEqual([]);
    // A conditional branch, a tuple element, and a function type's return are
    // all types, and a bracket or parenthesis in a type position holds types.
    expect(text).not.toContain("boxed<");
  });

  test("leaves a value of the same spelling alone", () => {
    const { text, messages } = expand(
      macros,
      `import { boxed } from "./macros.sts" for syntax;
       export function use(): number {
         const boxed = 1;
         return boxed + 1;
       }`,
    );
    // The name is only read as a type where a type is written.
    expect(messages).toEqual([]);
    expect(text).toContain("const boxed = 1");
    expect(text).toContain("return boxed + 1");
  });
});

describe("syntax-class refinements", () => {
  test("selects on the kind of token a capture matched", () => {
    const { text, messages } = expand(
      `export syntax class Quoted {
         fields { value: token; }
         rule { $value:token }
           refine $value token-kind (string-literal);
       }

       export syntax classify:expr {
         rule { classify($value:Quoted) } => { ["text", $value.value] }
         rule { classify($value:token) } => { ["other", $value] }
       }`,
      `import { classify } from "./macros.sts" for syntax;
export const a = classify("hello");
export const b = classify(1);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain(`export const a = ["text", "hello"];`);
    expect(text).toContain(`export const b = ["other", 1];`);
  });

  test("selects on how a token is spelled", () => {
    const { text, messages } = expand(
      `export syntax class Always {
         fields { word: token; }
         rule { $word:token }
           refine $word spelling equals "always";
       }

       export syntax class Accessor {
         fields { word: token; }
         rule { $word:token }
           refine $word spelling in (get, set);
       }

       export syntax class Lower {
         fields { word: token; }
         rule { $word:token }
           refine $word spelling starts-with-lowercase;
       }

       export syntax pick:expr {
         rule { pick($word:Always) } => { ["keyword", #text($word.word)] }
         rule { pick($word:Accessor) } => { ["accessor", #text($word.word)] }
         rule { pick($word:Lower) } => { ["lower", #text($word.word)] }
         rule { pick($word:token) } => { ["other", #text($word)] }
       }`,
      `import { pick } from "./macros.sts" for syntax;
export const a = pick(always);
export const b = pick(get);
export const c = pick(set);
export const d = pick(other);
export const e = pick(Other);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain(`export const a = ["keyword", "always"];`);
    expect(text).toContain(`export const b = ["accessor", "get"];`);
    expect(text).toContain(`export const c = ["accessor", "set"];`);
    expect(text).toContain(`export const d = ["lower", "other"];`);
    expect(text).toContain(`export const e = ["other", "Other"];`);
  });

  test("selects on which delimiter surrounds a capture", () => {
    const { text, messages } = expand(
      `export syntax class Braced {
         fields { body: tt; }
         rule { $body:tt }
           refine $body delimiter brace;
       }

       export syntax shape:expr {
         rule { shape($body:Braced) } => { ["braced", #text($body.body)] }
         rule { shape($body:tt) } => { ["other", #text($body)] }
       }`,
      `import { shape } from "./macros.sts" for syntax;
export const a = shape({ x: 1 });
export const b = shape([2]);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain(`export const a = ["braced", "{ x: 1 }"];`);
    expect(text).toContain(`export const b = ["other", "[2]"];`);
  });

  test("selects on how many times a repetition matched", () => {
    const { text, messages } = expand(
      `export syntax class Pair {
         fields { values: expr*; }
         rule { $($values:expr),* }
           refine $values length equal 2;
       }

       export syntax count:expr {
         rule { count($values:Pair) } => { ["pair", $($values.values),*] }
         rule { count($($values:expr),*) } => { ["other", $($values),*] }
       }`,
      `import { count } from "./macros.sts" for syntax;
export const a = count(1, 2);
export const b = count(1, 2, 3);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain(`export const a = ["pair", 1, 2];`);
    expect(text).toContain(`export const b = ["other", 1, 2, 3];`);
  });

  test("rejects a predicate the matcher cannot decide", () => {
    // `followed-by` is evaluated against context the matcher never fills in, so
    // a rule written with it would silently match everything. Refusing it makes
    // that a mistake the author is told about instead.
    const { messages } = expand(
      `export syntax class Trailing {
         fields { value: expr; }
         rule { $value:expr }
           refine $value followed-by ";";
       }

       export syntax never:expr {
         rule { never($value:Trailing) } => { $value.value }
       }`,
      `import { never } from "./macros.sts" for syntax;
export const a = never(1);
`,
    );
    expect(messages).toContain(
      "Invalid refinement target or predicate for $value.",
    );
  });
});

describe("macro match failures", () => {
  test("says which literal a rule was still waiting for", () => {
    const { messages } = expand(
      `export syntax unless:stmt {
         rule { unless ($condition:expr) then { $body:stmt ... } }
           => { if (!($condition)) { $body ... } }
       }`,
      `import { unless } from "./macros.sts" for syntax;
export function f(x: number): number {
  unless (x > 0) { return 1; }
  return 2;
}
`,
    );
    expect(messages.join("\n")).toContain("expected `then`");
  });

  test("says which syntax class a rule was still waiting for", () => {
    const { messages } = expand(
      `export syntax typed:expr {
         rule { typed($name:ident) } => { #text($name) }
       }`,
      `import { typed } from "./macros.sts" for syntax;
export const a = typed(1);
`,
    );
    expect(messages.join("\n")).toContain("expected `ident`");
  });

  test("says when a rule wanted the invocation to end", () => {
    // The shape that reads as an ordinary trailing comma but needs a rule of
    // its own; a count of rules tried would not say what is wrong with it.
    const { messages } = expand(
      `export syntax pipeline:expr {
         rule { pipeline($head:expr, $step:expr) } => { $step($head) }
       }`,
      `import { pipeline } from "./macros.sts" for syntax;
declare function top(n: number): (values: number[]) => number[];
export const a = pipeline([1, 2, 3], top(2),);
`,
    );
    expect(messages.join("\n")).toContain("expected the end of the group");
    expect(messages.join("\n")).not.toContain("rule attempt(s)");
  });

  test("uses the wording a rule supplied, as supplied", () => {
    const { messages } = expand(
      `export syntax field:expr {
         rule { field($name:ident : $kind:ident) }
           expect "a field type after the colon";
           => { [#text($name), #text($kind)] }
       }`,
      `import { field } from "./macros.sts" for syntax;
export const a = field(size :);
`,
    );
    expect(messages.join("\n")).toContain("a field type after the colon");
    expect(messages.join("\n")).not.toContain("expected a field type");
  });
});

describe("statement macros at the top level of a module", () => {
  test("dispatches where a statement is written outside any function", () => {
    // A module's top level takes statements, so a statement macro belongs
    // there, not only inside a function body. Unresolved, a top-level use
    // reports the macro as an undefined name.
    const { text, messages } = expand(
      `export syntax unless:stmt {
         rule { unless ($condition:expr) { $($body:stmt)* } }
           => { if (!($condition)) { $($body)* } }
       }`,
      `import { unless } from "./macros.sts" for syntax;
declare const value: number;
unless (value > 0) {
  globalThis.console.log("not positive");
}
export const kept = value;
`,
    );
    expect(messages).toEqual([]);
    expect(text.replaceAll(/\s+/gu, "")).toContain("if(!(value>0))");
    expect(text).not.toContain("unless");
  });

  test("still dispatches inside a function body", () => {
    const { text, messages } = expand(
      `export syntax unless:stmt {
         rule { unless ($condition:expr) { $($body:stmt)* } }
           => { if (!($condition)) { $($body)* } }
       }`,
      `import { unless } from "./macros.sts" for syntax;
export function f(value: number): string {
  unless (value > 0) { return "no"; }
  return "yes";
}
`,
    );
    expect(messages).toEqual([]);
    expect(text.replaceAll(/\s+/gu, "")).toContain("if(!(value>0))");
  });

  test("leaves an ordinary call of the same shape alone", () => {
    const { text, messages } = expand(
      `export syntax noop:stmt {
         rule { noop(); } => { { } }
       }`,
      `import { noop } from "./macros.sts" for syntax;
declare function report(value: number): void;
report(1);
export const kept = 1;
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("report(1);");
  });
});

describe("macros beside TypeScript the parser has to understand", () => {
  const twice = `export syntax twice:expr {
    rule { twice($value:expr) } => { [$value, $value] }
  }`;

  test("a type assertion does not stop the body around it expanding", () => {
    // `as` and `satisfies` take a type, not an expression. Parsed as one,
    // `as const` does not parse at all, and the whole function body falls back
    // to unexpanded tokens — silently, with check reporting success.
    const { text, messages } = expand(
      twice,
      `import { twice } from "./macros.sts" for syntax;
export function run(): readonly number[] {
  const mode = "a" as const;
  void mode;
  return twice(21);
}
`,
    );
    expect(messages).toEqual([]);
    expect(text.replaceAll(/\s+/gu, "")).toContain("[21,21]");
    expect(text).not.toContain("twice(21)");
  });

  test("every assertion form parses as the type it is", () => {
    // Each written over something the assertion is actually valid on, so a
    // diagnostic here is the parse and not TypeScript objecting.
    for (const [subject, assertion] of [
      ["[1, 2]", "as const"],
      ["value", "as number"],
      ["names", "as string[]"],
      ["value", "satisfies number"],
    ] as const) {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
declare const value: number;
declare const names: string[];
export const kept = twice(${subject} ${assertion});
`,
      );
      expect(messages, assertion).toEqual([]);
      expect(text.replaceAll(/\s+/gu, ""), assertion).toContain(
        `${subject.replaceAll(" ", "")}${assertion.replaceAll(" ", "")}`,
      );
    }
  });

  test("yield* does not stop the body around it expanding", () => {
    const { text, messages } = expand(
      twice,
      `import { twice } from "./macros.sts" for syntax;
export function* run(): Generator<number, readonly number[], unknown> {
  yield* [1, 2];
  return twice(21);
}
`,
    );
    expect(messages).toEqual([]);
    const compact = text.replaceAll(/\s+/gu, "");
    expect(compact).toContain("[21,21]");
    expect(compact).toContain("yield*[1,2]");
  });

  // A return type may hold an object type. Its braces are part of the type,
  // and the body is the brace after the whole type, so a macro in the body
  // expands.
  for (const [form, main] of [
    [
      "a class method",
      `export class Shapes {
  make(): { a: number } {
    return { a: twice(1)[0] };
  }
}`,
    ],
    [
      "a class method returning a function type",
      `export class Shapes {
  make(): () => { a: number } {
    return () => ({ a: twice(1)[0] });
  }
}`,
    ],
    [
      "a class method with a type predicate",
      `export class Shapes {
  test(value: unknown): value is { a: number } {
    return twice(value)[0] !== undefined;
  }
}`,
    ],
    [
      "a class method returning a union of object types",
      `export class Shapes {
  make(): { a: number } | { b: string } {
    return { a: twice(1)[0] };
  }
}`,
    ],
    [
      "a class method returning a conditional type",
      `export class Shapes {
  make<T>(): T extends { a: infer U } ? { u: U } : {} {
    return twice(null!)[0];
  }
}`,
    ],
    [
      "a class accessor",
      `export class Shapes {
  get made(): { a: number } {
    return { a: twice(1)[0] };
  }
}`,
    ],
    [
      "a class method of a class inside a function",
      `export function build(): unknown {
  class Shapes {
    make(): { a: number } {
      return { a: twice(1)[0] };
    }
  }
  return Shapes;
}`,
    ],
    [
      "a function declaration",
      `export function make(): { a: number } {
  return { a: twice(1)[0] };
}`,
    ],
    [
      "a function declaration with an assertion predicate",
      `export function check(value: unknown): asserts value is { a: number } {
  void twice(value);
}`,
    ],
    [
      "a function declaration inside a function",
      `export function outer(): unknown {
  function make(): { a: number } {
    return { a: twice(1)[0] };
  }
  return make;
}`,
    ],
    [
      "a function expression",
      `export const make = function (): { a: number } {
  return { a: twice(1)[0] };
};`,
    ],
    [
      "an object literal method",
      `export const shapes = {
  make(): { a: number } {
    return { a: twice(1)[0] };
  },
};`,
    ],
    [
      "an arrow with a concise body",
      `export const make = (): { a: number } => ({ a: twice(1)[0] });`,
    ],
    [
      "an arrow with a block body",
      `export const make = (): { a: number } => {
  return { a: twice(1)[0] };
};`,
    ],
  ] as const) {
    test(`an object type in the return type of ${form} is not its body`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).not.toContain("twice(");
    });
  }

  // A return type is a type wherever the function it belongs to is written,
  // so a type macro in one is looked up among type macros.
  const shaped = `export syntax list:type {
    rule { list<$element:type> } => { readonly $element[] }
  }`;

  for (const [form, main] of [
    [
      "a function declaration",
      `export function make(): { a: list<string> } {
  return { a: ["x"] };
}`,
    ],
    [
      "a class method",
      `export class Shapes {
  make(): { a: list<string> } {
    return { a: ["x"] };
  }
}`,
    ],
    [
      "a function expression",
      `export const make = function (): { a: list<string> } {
  return { a: ["x"] };
};`,
    ],
    [
      "an arrow",
      `export const make = (): { a: list<string> } => ({ a: ["x"] });`,
    ],
    [
      "an object literal method",
      `export const shapes = {
  make(): { a: list<string> } {
    return { a: ["x"] };
  },
};`,
    ],
    [
      "an arrow returning a union of object types",
      `export const make = (): { a: list<string> } | undefined => ({ a: ["x"] });`,
    ],
  ] as const) {
    test(`an object type in the return type of ${form} holds types`, () => {
      const { text, messages } = expand(
        shaped,
        `import { list } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("readonly string[]");
      expect(text).not.toContain("list<");
    });
  }

  // The `=>` of a function type stands inside the return type, so the object
  // type after it is a type and not the function's body.
  for (const [form, main] of [
    [
      "a function declaration",
      `export function make(): () => { a: number } {
  return () => ({ a: 1 });
}`,
    ],
    [
      "a class method",
      `export class Shapes {
  make(): () => { a: number } {
    return () => ({ a: 1 });
  }
}`,
    ],
    [
      "an arrow",
      `export const make = (): (() => { a: number }) => () => ({ a: 1 });`,
    ],
  ] as const) {
    test(`an object type after a function type's arrow in ${form} holds members`, () => {
      const { text, messages } = expand(
        `export syntax fields:typeMember {
           rule { fields $name:ident; } => { $name: number; }
         }`,
        `import { fields } from "./macros.sts" for syntax;
${main.replace("{ a: number }", "{ fields a; }")}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("a: number");
      expect(text).not.toContain("fields a");
    });
  }

  test("a type macro spanning a line break in an interface member expands", () => {
    // A member reads on while the line cannot end: `keyof` needs the type
    // after it, wherever it is written.
    const { text, messages } = expand(
      shaped,
      `import { list } from "./macros.sts" for syntax;
export interface Shape {
  a: keyof
    list<string>;
  b: number;
}
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("readonly string[]");
  });

  // Type arguments nest, and each `>` closes one of them. A count that took a
  // token for a single angle would leave the depth wrong, and with it every
  // reading that depends on it: where a member ends, where a type is written.
  for (const [form, main] of [
    [
      "an interface member",
      `export interface Shapes {
  sizes: Map<string, Map<string, Map<string, list<number>>>>;
  names: list<string>;
}`,
    ],
    [
      "a class member with no semicolon after it",
      `export class Shapes {
  sizes!: Map<string, Map<string, Array<list<number>>>>
  names: list<string> = [];
}`,
    ],
    [
      "a method's return type",
      `export class Shapes {
  make(): Map<string, Array<list<number>>> {
    return new Map();
  }
}`,
    ],
    [
      "a heritage clause's type arguments",
      `declare const Base: new <T>() => object;
export class Shapes extends Base<Map<string, list<number>>> {}`,
    ],
    [
      "a generic method's constraint",
      `export const shapes = {
  keep<T extends Map<string, Array<list<number>>>>(value: T): T {
    return value;
  },
};`,
    ],
  ] as const) {
    test(`a type macro expands inside the nested type arguments of ${form}`, () => {
      const { text, messages } = expand(
        `export syntax list:type {
           rule { list<$element:type> } => { readonly $element[] }
         }`,
        `import { list } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("readonly number[]");
      expect(text).not.toContain("list<number>");
    });
  }

  // What a class implements, what an interface extends, and what constrains a
  // type parameter are types, so a type macro is looked up in each of them.
  // TypeScript takes only a name in a heritage clause, so the macro names one.
  const sized = `export syntax sized:type {
    rule { sized } => { Sized }
  }`;
  const declaresSized = `interface Sized {
  size: number;
}`;

  for (const [form, main] of [
    [
      "what a class implements",
      `export class Shape implements sized {
  size = 1;
}`,
    ],
    [
      "a second entry of an implements clause",
      `interface Named {
  name: string;
}
export class Shape implements Named, sized {
  name = "shape";
  size = 1;
}`,
    ],
    [
      "what an interface extends",
      `export interface Shape extends sized {
  name: string;
}`,
    ],
    [
      "a type parameter's constraint",
      `export function keep<T extends sized>(value: T): T {
  return value;
}`,
    ],
    [
      "a type parameter's default",
      `export function make<T extends object = sized>(value: T): T {
  return value;
}`,
    ],
    [
      "the return type of a construct signature",
      `export interface Factory {
  new (): sized;
}`,
    ],
  ] as const) {
    test(`a type macro expands in ${form}`, () => {
      const { text, messages } = expand(
        sized,
        `import { sized } from "./macros.sts" for syntax;
${declaresSized}
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("Sized");
      expect(text).not.toMatch(/\bsized\b/u);
    });
  }

  // Type arguments hold commas of their own, and the comma that separates
  // members is the one outside them.
  for (const [form, main] of [
    [
      "an interface member",
      `export interface Shape {
  sizes: Map<string, list<number>>;
}`,
    ],
    [
      "an object type's member",
      `export type Shape = { sizes: Map<string, list<number>> };`,
    ],
    [
      "a method member's parameter",
      `export interface Shape {
  resize(sizes: Map<string, list<number>>): void;
}`,
    ],
    [
      "a member after one that ends in type arguments",
      `export interface Shape {
  sizes: Map<string, number>,
  names: list<number>,
}`,
    ],
  ] as const) {
    test(`a type macro expands after a comma in the type arguments of ${form}`, () => {
      const { text, messages } = expand(
        `export syntax list:type {
           rule { list<$element:type> } => { readonly $element[] }
         }`,
        `import { list } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("readonly number[]");
      expect(text).not.toContain("list<number>");
    });
  }

  // A conditional's consequent may be an arrow with a return type, which
  // TypeScript reads only when the conditional's own `:` follows the arrow's
  // body. Its parameter is an ordinary binding, and shadows the macro.
  for (const [form, main] of [
    [
      "a conditional",
      `declare const ready: boolean;
export const run = ready
  ? (twice: (value: number) => number): number => twice(1)
  : 3;`,
    ],
    [
      "a conditional inside a conditional",
      `declare const ready: boolean;
export const run = ready
  ? ready
    ? (twice: (value: number) => number): number => twice(1)
    : 1
  : 2;`,
    ],
  ] as const) {
    test(`an arrow with a return type in the consequent of ${form} binds its parameter`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("=> twice(1)");
    });
  }

  test("a parenthesized expression in a conditional's consequent expands", () => {
    // Read as an arrow's parameter list, the names in it would be bound and
    // the macro written there would not be looked up at all.
    const { text, messages } = expand(
      twice,
      `import { twice } from "./macros.sts" for syntax;
declare const ready: boolean;
export const run = ready ? twice(21)[0] : 3;
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("[21, 21]");
  });

  // A heritage clause's arguments are a call's, so they hold expressions and
  // bind nothing: read as a parameter list, the names in them would shadow the
  // macros written there.
  for (const [form, main] of [
    [
      "a call in a class declaration's extends clause",
      `declare function mixin(values: readonly number[]): new () => {
  size: number;
};
export class Sized extends mixin(twice(21)) {
  report(): number {
    return this.size;
  }
}`,
    ],
    [
      "a call in a class expression's extends clause",
      `declare function mixin(values: readonly number[]): new () => {
  size: number;
};
export const Sized = class extends mixin(twice(21)) {};`,
    ],
    [
      "a parenthesized class expression in an extends clause",
      `export class Holder extends (class {
  size = twice(21)[0];
}) {}`,
    ],
    [
      "a decorated class declaration",
      `declare function deco(target: unknown, context: ClassDecoratorContext): void;
@(deco)
export class Decorated {
  size = twice(21)[0];
}`,
    ],
  ] as const) {
    test(`a macro expands in ${form}`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("[21, 21]");
      expect(text).not.toContain("twice(");
    });
  }

  test("a parameter shadows a macro of its name in a function with a return type", () => {
    // A parameter is an ordinary binding, and a nearer binding shadows a
    // macro, so the body calls the parameter.
    const { text, messages } = expand(
      twice,
      `import { twice } from "./macros.sts" for syntax;
export function run(twice: (value: number) => number): number {
  return twice(1);
}
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return twice(1)");
  });

  test("members with parenthesized decorators are read as members", () => {
    // `@(expr)` and `@name()` are decorators. A macro that emits members
    // written with them has its expansion read as those members, and a body
    // holding them is read member by member, so the field macro after a field
    // with no semicolon is found at the head of a member of its own.
    const { text, messages } = expand(
      `${twice}
      export syntax fields:classElement {
        rule { fields $name:ident; } => {
          @(logged) $name = 0;
          @(factory()) other = twice(3);
        }
      }`,
      `import { twice, fields } from "./macros.sts" for syntax;
declare function logged(value: undefined, context: ClassFieldDecoratorContext): void;
declare function factory(): (value: undefined, context: ClassFieldDecoratorContext) => void;
export class Box {
  @(factory()) first = twice(1);
  @(logged) second = twice(2)
  fields counted;
}
`,
    );
    expect(messages).toEqual([]);
    const compact = text.replaceAll(/\s+/gu, "");
    expect(compact).toContain("@(factory())first=[1,1];");
    expect(compact).toContain("@(logged)second=[2,2]");
    expect(compact).toContain("@(logged)counted=0;");
    expect(compact).toContain("@(factory())other=[3,3];");
  });

  // Whether `yield` is an expression is decided by the function it is written
  // directly in. `$value:expr` captures `yield 1` only where it is one, so each
  // of these expands only if that function is recognized as a generator.
  for (const [form, main] of [
    [
      "a generator method in a class",
      `export class Pairs {
  *run(): Generator<number, unknown, unknown> {
    return twice(yield 1);
  }
}`,
    ],
    [
      "a static async generator method in a class",
      `export class Pairs {
  static async *run(): AsyncGenerator<number, unknown, unknown> {
    return twice(yield 1);
  }
}`,
    ],
    [
      "a generator method in an object literal",
      `export const pairs = {
  *run(): Generator<number, unknown, unknown> {
    return twice(yield 1);
  },
};`,
    ],
    [
      "a generator function expression",
      `export const run = function* (): Generator<number, unknown, unknown> {
  return twice(yield 1);
};`,
    ],
    // A computed member name is evaluated where the class is written, so it
    // is inside the generator around the class.
    [
      "a computed method name in a class inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  class Keys {
    [twice(yield 1)[0] as number](): number {
      return 1;
    }
  }
  return Keys;
}`,
    ],
    // A parenthesis group after an operand is an argument list, never an
    // arrow's parameters, even where an arrow follows it in a conditional.
    [
      "a call in a conditional whose alternative is an arrow",
      `declare function f(value: unknown): number;
export function* run(cond: boolean): Generator<number, unknown, unknown> {
  const pick = cond ? f(twice(yield 1)) : (y: number) => y;
  return pick;
}`,
    ],
    [
      "a method call in a conditional whose alternative is an arrow",
      `declare const o: { m(value: unknown): number };
export function* run(cond: boolean): Generator<number, unknown, unknown> {
  const pick = cond ? o.m(twice(yield 1)) : (y: number): number => y;
  return pick;
}`,
    ],
    [
      "a call to a function named async in a conditional whose alternative is an arrow",
      `declare function async(value: unknown): number;
export function* run(cond: boolean): Generator<number, unknown, unknown> {
  const pick = cond ? async(twice(yield 1)) : (y: number) => y;
  return pick;
}`,
    ],
    [
      "a call followed by a conditional whose alternative is an arrow",
      `declare function f(value: unknown): number;
export function* run(): Generator<number, unknown, unknown> {
  const pick = f(twice(yield 1)) ? 0 : (y: number) => y;
  return pick;
}`,
    ],
    // A parameter list admits no `yield`, but a generator written in one has a
    // body of its own.
    [
      "a generator function expression that is a parameter default",
      `export function run(
  make = function* (): Generator<number, unknown, unknown> {
    return twice(yield 1);
  },
): unknown {
  return make;
}`,
    ],
  ] as const) {
    test(`yield is an expression in ${form}`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages).toEqual([]);
      expect(text.replaceAll(/\s+/gu, "")).toContain("[yield1,yield1]");
      expect(text).not.toContain("twice(");
    });
  }

  test("a class body walked as tokens ends a member where the member reader does", () => {
    // `@1` is a decorator TypeScript rejects, so the member reader cannot take
    // the body and it is walked as tokens. The field's initializer, where
    // `yield` is not an expression, still ends at the line break before the
    // next member, whose computed name is inside the generator around the
    // class.
    const { text, messages } = expand(
      twice,
      `import { twice } from "./macros.sts" for syntax;
export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    @1 value = 1
    static [twice(yield 1)[0] as number](): number {
      return 1;
    }
  }
  return Inner;
}
`,
    );
    expect(messages).toContain(
      "Expression must be enclosed in parentheses to be used as a decorator.",
    );
    expect(messages.join("\n")).not.toContain("No rule for macro twice");
    expect(text.replaceAll(/\s+/gu, "")).toContain("[yield1,yield1]");
  });

  // A class member ends where TypeScript ends it. After a field with a type
  // and no initializer, a line beginning `*` begins a generator member whose
  // computed name is inside the generator around the class.
  test("a line beginning with a star after a typed field begins a member", () => {
    const { text, messages } = expand(
      twice,
      `import { twice } from "./macros.sts" for syntax;
export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    first!: number
    *[twice(yield 1)[0] as number](): Generator<number, void, unknown> {}
  }
  return Inner;
}
`,
    );
    expect(messages).toEqual([]);
    expect(text.replaceAll(/\s+/gu, "")).toContain("[yield1,yield1]");
  });

  // After a field's initializer, a line that can continue the initializer
  // does: TypeScript reads each of these as one field whose initializer holds
  // `yield`, which is not an expression there.
  for (const [form, member] of [
    ["an element access", "first = 1\n    [twice(yield 1)[0] as number] = 2"],
    [
      "an operator at the end of the line",
      "first = 1 +\n    twice(yield 1)[0]",
    ],
  ] as const) {
    test(`a field's initializer continues onto the next line through ${form}`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    ${member}
  }
  return Inner;
}
`,
      );
      expect(messages.join("\n")).toContain("No rule for macro twice");
      expect(text.replaceAll(/\s+/gu, "")).not.toContain("[yield1,yield1]");
    });
  }

  // TypeScript rejects `yield` in a parameter initializer, even a generator's
  // own, and in a class field initializer or static block, even of a class
  // inside a generator: each is evaluated as a function of its own. A capture
  // of `yield 1` as an expression there is refused.
  for (const [form, main] of [
    [
      "a generator's parameter default",
      `export function* run(
  value: unknown = twice(yield 1),
): Generator<number, unknown, unknown> {
  return value;
}`,
    ],
    [
      "a generator method's parameter default",
      `export class Pairs {
  *run(value: unknown = twice(yield 1)): Generator<number, unknown, unknown> {
    return value;
  }
}`,
    ],
    [
      "an arrow's parameter default inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  const inner = (value: unknown = twice(yield 1)) => value;
  return inner;
}`,
    ],
    [
      "an async arrow's parameter default inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  const inner = async (value: unknown = twice(yield 1)) => value;
  return inner;
}`,
    ],
    [
      "a nested function declaration's parameter default",
      `export function* run(): Generator<number, unknown, unknown> {
  function inner(value: unknown = twice(yield 1)): unknown {
    return value;
  }
  return inner;
}`,
    ],
    [
      "a nested function expression's parameter default",
      `export function* run(): Generator<number, unknown, unknown> {
  const inner = function (value: unknown = twice(yield 1)): unknown {
    return value;
  };
  return inner;
}`,
    ],
    [
      "a nested object literal method's parameter default",
      `export function* run(): Generator<number, unknown, unknown> {
  const inner = {
    run(value: unknown = twice(yield 1)): unknown {
      return value;
    },
  };
  return inner;
}`,
    ],
    [
      "a nested class method's parameter default",
      `export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    run(value: unknown = twice(yield 1)): unknown {
      return value;
    }
  }
  return Inner;
}`,
    ],
    [
      "the parameter default of an arrow passed as an argument",
      `export function* run(): Generator<number, unknown, unknown> {
  return [1].map((value: unknown = twice(yield 1)) => value);
}`,
    ],
    [
      "a class field initializer inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    value = twice(yield 1);
  }
  return Inner;
}`,
    ],
    [
      "a static field initializer inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    static value = twice(yield 1);
  }
  return Inner;
}`,
    ],
    [
      "a static block inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  class Inner {
    static {
      void twice(yield 1);
    }
  }
  return Inner;
}`,
    ],
    [
      "a class expression's field initializer inside a generator",
      `export function* run(): Generator<number, unknown, unknown> {
  const Inner = class {
    value = twice(yield 1);
  };
  return Inner;
}`,
    ],
  ] as const) {
    test(`yield is not an expression in ${form}`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
${main}
`,
      );
      expect(messages.join("\n")).toContain("No rule for macro twice");
      expect(text.replaceAll(/\s+/gu, "")).not.toContain("[yield1,yield1]");
    });
  }

  // A function nested in a generator is not one itself: TypeScript rejects
  // `yield` written directly in it, so a capture of `yield 1` as an expression
  // there is refused rather than expanded into code that does not compile.
  for (const [form, name, body] of [
    [
      "a function declaration",
      "inner",
      "function inner() { return twice(yield 1); }",
    ],
    [
      "a function expression",
      "inner",
      "const inner = function () { return twice(yield 1); };",
    ],
    ["an arrow", "inner", "const inner = () => twice(yield 1);"],
    [
      "an arrow with a block body",
      "inner",
      "const inner = () => { return twice(yield 1); };",
    ],
    [
      "an object literal method",
      "inner",
      "const inner = { run() { return twice(yield 1); } };",
    ],
    [
      "a class method",
      "Inner",
      "class Inner { run() { return twice(yield 1); } }",
    ],
    [
      "a class accessor",
      "Inner",
      "class Inner { get run() { return twice(yield 1); } }",
    ],
  ] as const) {
    test(`yield is not an expression in ${form} nested in a generator`, () => {
      const { text, messages } = expand(
        twice,
        `import { twice } from "./macros.sts" for syntax;
export function* run(): Generator<number, void, unknown> {
  ${body}
  void ${name};
}
`,
      );
      expect(messages.join("\n")).toContain("No rule for macro twice");
      expect(text.replaceAll(/\s+/gu, "")).not.toContain("[yield1,yield1]");
    });
  }
});

describe("#fresh", () => {
  test("gives a different name to each occurrence in one expansion", () => {
    // `#fresh` is the way a macro asks for a name that cannot collide, so it
    // must not collide with itself either: two of them emitting the same
    // identifier is a redeclaration TypeScript rejects.
    const { text, messages } = expand(
      `export syntax pair:stmt {
         rule { pair($a:expr, $b:expr); } => {
           const #fresh("tmp") = $a;
           const #fresh("tmp") = $b;
         }
       }`,
      `import { pair } from "./macros.sts" for syntax;
export function demo(): number {
  pair(1, 2);
  return 0;
}
`,
    );
    expect(messages).toEqual([]);
    const names = [...text.matchAll(/const (tmp\w*) =/gu)].map(
      ([, name]) => name,
    );
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  test("gives a different name to each turn of a repetition", () => {
    const { text, messages } = expand(
      `export syntax lets:stmt {
         rule { lets($($value:expr),*); } => { $(const #fresh("tmp") = $value;)* }
       }`,
      `import { lets } from "./macros.sts" for syntax;
export function demo(): number {
  lets(1, 2, 3);
  return 0;
}
`,
    );
    expect(messages).toEqual([]);
    const names = [...text.matchAll(/const (tmp\w*) =/gu)].map(
      ([, name]) => name,
    );
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  test("still avoids a name the call site already uses", () => {
    const { text, messages } = expand(
      `export syntax one:stmt {
         rule { one($value:expr); } => { const #fresh("tmp") = $value; }
       }`,
      `import { one } from "./macros.sts" for syntax;
export function demo(): number {
  const tmp = 9;
  one(1);
  return tmp;
}
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("const tmp = 9;");
    expect(text).toMatch(/const tmp_\d+ =/u);
  });
});

describe("arrow functions", () => {
  test("a concise-bodied arrow written in a template is emitted as written", () => {
    // A plain arrow is an expression as much as a generic one is. Left to the
    // infix `=>`, which protects what stands to its left, it is emitted with a
    // parameter list wrapped in its own parentheses, which does not parse.
    const { text, messages } = expand(
      `export syntax define:item {
         rule { define($name:ident) } => {
           export const $name = (value: number) => value + 1;
         }
       }`,
      `import { define } from "./macros.sts" for syntax;
define(increment);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(value: number) => value + 1");
  });

  test("keeps the whole body, not its first token", () => {
    const { text } = expand(
      `export syntax define:item {
         rule { define($name:ident) } => {
           export const $name = (value: number) => value * 2 + 1;
         }
       }`,
      `import { define } from "./macros.sts" for syntax;
define(scaled);
`,
    );
    // `(v) => v * 2 + 1`, not `((v) => v) * 2 + 1`.
    expect(text).toContain("=> value * 2 + 1");
  });

  test("a zero-parameter arrow is an expression", () => {
    for (const source of ["() => 1", "async () => 1"]) {
      const { text, messages } = expand(
        `export syntax wrap:expr { rule { wrap($value:expr) } => { [$value] } }`,
        `import { wrap } from "./macros.sts" for syntax;
export const held = wrap(${source});
`,
      );
      expect(messages, source).toEqual([]);
      expect(text, source).toContain(source);
    }
  });
});

describe("expression grouping", () => {
  test("keeps a macro's own operators from re-binding outward", () => {
    // `sum(1, 2) * 10` must expand to `(1 + 2) * 10`, not `1 + 2 * 10`, which
    // computes 21 rather than 30 — silently, with the project type-checking
    // clean. The expansion is one expression and has to stay one.
    const { text, messages } = expand(
      `export syntax sum:expr {
         rule { sum($a:expr, $b:expr) } => { $a + $b }
       }`,
      `import { sum } from "./macros.sts" for syntax;
export const total: number = sum(1, 2) * 10;
`,
    );
    expect(messages).toEqual([]);
    const compact = text.replaceAll(/\s+/gu, "");
    expect(compact).toContain("(1+2)*10");
    expect(evalExport(text, "total")).toBe(30);
  });

  test("keeps a captured expression from re-binding against the template", () => {
    // `dbl(1 + 2)` with template `$v * 2` must not expand to `1 + 2 * 2`,
    // which computes 5 rather than 6.
    const { text, messages } = expand(
      `export syntax dbl:expr {
         rule { dbl($value:expr) } => { $value * 2 }
       }`,
      `import { dbl } from "./macros.sts" for syntax;
export const total: number = dbl(1 + 2);
`,
    );
    expect(messages).toEqual([]);
    expect(evalExport(text, "total")).toBe(6);
  });

  test("adds no parentheses where nothing can re-bind", () => {
    // A call, a member chain or a literal cannot be re-associated by what
    // surrounds it, and wrapping those turns readable output into nests of
    // redundant parentheses.
    const { text, messages } = expand(
      `export syntax call:expr {
         rule { call($f:expr, $v:expr) } => { $f($v) }
       }`,
      `import { call } from "./macros.sts" for syntax;
declare function twice(value: number): number;
export const total: number = call(twice, 3);
`,
    );
    expect(messages).toEqual([]);
    const compact = text.replaceAll(/\s+/gu, "");
    expect(compact).toContain("twice(3)");
    expect(compact).not.toContain("(twice(3))");
  });
});
