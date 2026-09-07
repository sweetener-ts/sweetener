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
    expect(text).toContain("export const some = [true&& (size > 0)]");
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
    expect(text).toContain("export const none = [ true]");
    expect(text).toContain("export const some = [(size > 0)]");
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
    expect(text).toContain("[[ 1, true],[ 3, (size > 0)]]");
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
    // The head, the body, and the closing brace were one invocation.
    expect(text).toContain("([1, 2]).map(( value) =>");
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
    expect(text).toContain("globalThis.console.log( 1)");
    expect(text).toContain("globalThis.console.log( 2)");
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
    expect(text).toContain('fields: ["x","y"]');
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
    expect(text).toContain(`export const a = ["pair",1, 2];`);
    expect(text).toContain(`export const b = ["other",1, 2, 3];`);
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
    // its own, which reported only a count of rules tried.
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
    // there. It used to resolve only inside a function body, and a top-level
    // use reported the macro as an undefined name.
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
    expect(text.replaceAll(/\s+/gu, "")).toContain("if(!((value>0)))");
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
    expect(text.replaceAll(/\s+/gu, "")).toContain("if(!((value>0)))");
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
    // `as const` did not parse at all, and the whole function body fell back
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
});

describe("#fresh", () => {
  test("gives a different name to each occurrence in one expansion", () => {
    // `#fresh` is the way a macro asks for a name that cannot collide, and it
    // used to collide with itself: two of them emitted the same identifier,
    // which TypeScript rejected as a redeclaration.
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
    // Only generic arrows were recognised as expressions, so a plain one fell
    // to the infix `=>`, which protects what stands to its left — emitting a
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
    // `sum(1, 2) * 10` used to expand to `1 + 2 * 10`, which computes 21
    // rather than 30 — silently, with the project type-checking clean. The
    // expansion is one expression and has to stay one.
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
    // `dbl(1 + 2)` with template `$v * 2` used to expand to `1 + 2 * 2`,
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
    // surrounds it, and wrapping those turned readable output into nests of
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
