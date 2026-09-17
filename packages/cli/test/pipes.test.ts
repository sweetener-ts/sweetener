import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Pipe operators: Elixir's and TC39's Hack pipe, as the playground writes
 * them, and an F#-style pipe written here to hold the operator features it
 * needs.
 *
 * The Elixir pipe makes the value on its left the first argument of the call
 * on its right. The Hack pipe evaluates any expression with `%` standing for
 * that value, and is checked against what its proposal says, including the
 * programs the proposal makes errors. Between them the pipes needed an
 * operator whose right side may be `await` or an unparenthesized arrow, a
 * refinement on the form of an expression, a syntax parameter the body must
 * use, and `#let`, which keeps `await` and `yield` in the function they belong
 * to.
 */

const examples = resolve(import.meta.dirname, "../../../playground/examples");
const elixir = readFileSync(join(examples, "pipe-elixir/macros.sts"), "utf8");
const fsharp = `
export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 35;
  operand arrow;

  rule { $value:expr |> await } => { await $value }

  rule { $value:expr |> $function:expr }
  refine $function form not in (await);
  => {
    #let(argument = $value) { $function(argument) }
  }
}
`;
const hack = readFileSync(join(examples, "pipe-hack/macros.sts"), "utf8");

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-pipes-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        target: "ES2024",
        lib: ["ES2024", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  return {
    generated:
      expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text ?? "",
    messages: expanded.diagnostics.map(
      ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
    ),
  };
}

/** Everything a program exports, once its expansion has run. */
function evaluate(generated: string): Record<string, unknown> {
  const javascript = ts.transpileModule(generated, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("exports", javascript)(exports);
  return exports;
}

/** Type errors in the expansion, beyond the expansion's own diagnostics. */
function typeErrors(generated: string): readonly string[] {
  const fileName = "/pipes.generated.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, fresh) =>
    requested === fileName
      ? ts.createSourceFile(fileName, generated, languageVersion, true)
      : original(requested, languageVersion, onError, fresh);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    );
}

const fsharpImport = 'import { (|>) } from "./macros.sts" for syntax;\n';
const hackImport = 'import { (|>), (%) } from "./macros.sts" for syntax;\n';

describe("the Elixir pipe", () => {
  test("makes the value the first argument of each call", () => {
    const { generated, messages } = run(
      elixir,
      `${fsharpImport}
const map = (values: number[], f: (value: number) => number) => values.map(f);
const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
const text = { separator: "-", join(parts: number[], end: string) { return parts.join(this.separator) + end; } };
export const answer = [1, 2, 3] |> map((n) => n * 2) |> total;
export const called = [1, 2, 3] |> total();
export const joined = [1, 2] |> map((n) => n + 1) |> text.join("!");
export const clamped = 70 |> Math.min(50) |> Math.max(0);
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["answer"]).toBe(12);
    expect(exports["called"]).toBe(6);
    // A method keeps its object.
    expect(exports["joined"]).toBe("2-3!");
    expect(exports["clamped"]).toBe(50);
  });

  test("refuses a right side that is not a call or a function name", () => {
    const { messages } = run(
      elixir,
      `${fsharpImport}
export const value = 1 |> ((n: number) => n + 1);
`,
    );
    expect(messages.join("\n")).toContain(
      "a function call, like `f(a)`, or a function name",
    );
  });

  test("the playground example runs", () => {
    const { generated, messages } = run(
      elixir,
      readFileSync(join(examples, "pipe-elixir/main.sts"), "utf8"),
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["total"]).toBe(12);
    expect(exports["longest"]).toBe(5);
  });
});

describe("an F#-style pipe", () => {
  test("calls each function with the value before it", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const doubleSay = (text: string) => text + ", " + text;
const capitalize = (text: string) => text[0]!.toUpperCase() + text.slice(1);
const exclaim = (text: string) => text + "!";
export const result = "hello" |> doubleSay |> capitalize |> exclaim;
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    expect(evaluate(generated)["result"]).toBe("Hello, hello!");
  });

  test("ends an unparenthesized arrow at the next pipe", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const add = (x: number, y: number) => x + y;
const boundScore = (min: number, max: number, score: number) =>
  Math.max(min, Math.min(max, score));
export const newScore = 25
  |> (n) => n + n
  |> n => add(7, n)
  |> (n: number) => boundScore(0, 100, n);
export const outer = 1 |> n => [n] |> (list) => list.length;
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const exports = evaluate(generated);
    // The proposal's own example.
    expect(exports["newScore"]).toBe(57);
    // `[n] |> ...` is not inside the first arrow: the second arrow receives
    // the array the first one returned.
    expect(exports["outer"]).toBe(1);
  });

  test("keeps a method's receiver", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const counter = { step: 3, advance(value: number) { return value + this.step; } };
export const result = 4 |> counter.advance;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated)["result"]).toBe(7);
  });

  test("evaluates the value before the function", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
export const order: string[] = [];
const value = () => (order.push("value"), 1);
const pick = () => (order.push("function"), (n: number) => n + 1);
export const result = value() |> pick();
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["result"]).toBe(2);
    expect(exports["order"]).toEqual(["value", "function"]);
  });

  test("awaits the value when `await` is the step", async () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const lookup = async (id: number) => ({ id, name: "user " + String(id) });
export const name = async (id: number) =>
  id |> lookup |> await |> (user) => user.name;
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const name = evaluate(generated)["name"] as (id: number) => Promise<string>;
    await expect(name(3)).resolves.toBe("user 3");
  });

  test("refuses `await` applied to the function, as the proposal does", () => {
    const { messages } = run(
      fsharp,
      `${fsharpImport}
declare const f: Promise<(n: number) => number>;
export const result = async () => 1 |> await f;
`,
    );
    expect(messages.join("\n")).toContain(
      "No rule for macro |> accepted this input: an expression that is not an unparenthesized `await`",
    );
  });

  test("accepts a parenthesized `await` of the function", async () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const f = Promise.resolve((n: number) => n * 10);
export const result = async () => 4 |> (await f);
`,
    );
    expect(messages).toEqual([]);
    const result = evaluate(generated)["result"] as () => Promise<number>;
    await expect(result()).resolves.toBe(40);
  });

  test("binds looser than `??` and tighter than a conditional", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const double = (n: number) => n * 2;
export const nullish = (undefined as number | undefined) ?? 4 |> double;
export const conditional = true ? 1 : 2 |> double;
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["nullish"]).toBe(8);
    expect(exports["conditional"]).toBe(1);
  });
});

describe("the Hack pipe", () => {
  test("evaluates any expression with the topic", () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
const add = (a: number, b: number) => a + b;
export const call = 1 |> add(2, %);
export const chained = 1 |> % + 1 |> [%, % * 10] |> ({ first: %[0], second: %[1] });
export const method = "hi" |> %.toUpperCase() |> \`\${%}!\`;
export const remainder = 17 |> % % 5;
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["call"]).toBe(3);
    expect(exports["chained"]).toEqual({ first: 2, second: 20 });
    expect(exports["method"]).toBe("HI!");
    expect(exports["remainder"]).toBe(2);
  });

  test("evaluates the value once however often the body uses it", () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
export let calls = 0;
export const pair = (calls += 1) |> [%, %, %];
export const counted = () => calls;
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["pair"]).toEqual([1, 1, 1]);
    expect((exports["counted"] as () => number)()).toBe(1);
  });

  test("keeps `await` in the async function it is written in", async () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
const lookup = async (id: number) => ({ id, name: "user " + String(id) });
export async function named(id: number): Promise<string> {
  "use strict";
  return id |> await lookup(%) |> %.name.toUpperCase();
}
export const arrow = async (id: number) => id |> await lookup(%) |> %.id + 1;
export const object = {
  async method(id: number) { return id |> await lookup(%) |> %.name; },
};
export class Service {
  async find(id: number): Promise<Map<string, number>> {
    if (id > 0) {
      return id |> await lookup(%) |> new Map([[%.name, %.id]]);
    }
    return new Map();
  }
}
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    // The variable is declared where the function's own statements begin,
    // after its directive.
    expect(generated).toMatch(/"use strict";\s*let topic/u);
    const exports = evaluate(generated);
    await expect(
      (exports["named"] as (id: number) => Promise<string>)(2),
    ).resolves.toBe("USER 2");
    await expect(
      (exports["arrow"] as (id: number) => Promise<number>)(2),
    ).resolves.toBe(3);
    await expect(
      (exports["object"] as { method(id: number): Promise<string> }).method(5),
    ).resolves.toBe("user 5");
    const Service = exports["Service"] as new () => {
      find(id: number): Promise<Map<string, number>>;
    };
    await expect(new Service().find(7)).resolves.toEqual(
      new Map([["user 7", 7]]),
    );
  });

  test("keeps `yield` in the generator it is written in", () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
export function* conversation(
  from: number,
): Generator<number, number, number> {
  const answer = from |> (yield %) |> (yield % - 1);
  return answer;
}
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const generator = (
      evaluate(generated)["conversation"] as (
        from: number,
      ) => Generator<number, number, number>
    )(5);
    expect(generator.next()).toEqual({ value: 5, done: false });
    expect(generator.next(9)).toEqual({ value: 8, done: false });
    expect(generator.next(20)).toEqual({ value: 20, done: true });
  });

  test("gives each concurrent call of an async function its own topic", async () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
const later = (value: number, ms: number) =>
  new Promise<number>((done) => setTimeout(() => done(value), ms));
export const both = async (value: number, ms: number) =>
  value |> [%, await later(%, ms), %];
`,
    );
    expect(messages).toEqual([]);
    const both = evaluate(generated)["both"] as (
      value: number,
      ms: number,
    ) => Promise<number[]>;
    await expect(Promise.all([both(1, 20), both(2, 1)])).resolves.toEqual([
      [1, 1, 1],
      [2, 2, 2],
    ]);
  });

  test("uses a function where no `await` or `yield` needs the body kept in place", () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
export const closures = [1, 2, 3].map((n) => n |> (() => %));
`,
    );
    expect(messages).toEqual([]);
    expect(generated).not.toContain("let topic");
    const closures = evaluate(generated)["closures"] as (() => number)[];
    expect(closures.map((closure) => closure())).toEqual([1, 2, 3]);
  });

  test("gives a closure the topic of its own evaluation, in a loop and its header", async () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
const later = <T,>(value: T) => Promise.resolve(value);
const values = (getters: (() => number)[]) => getters.map((get) => get());

export async function block() {
  const getters: (() => number)[] = [];
  for (const id of [1, 2, 3]) {
    getters.push(id |> (await later(%), () => %));
  }
  return values(getters);
}
export async function bare() {
  const getters: (() => number)[] = [];
  for (const id of [1, 2, 3]) getters.push(id |> (await later(%), function () { return %; }));
  return values(getters);
}
export async function whileTest() {
  const getters: (() => number)[] = [];
  let i = 0;
  while ((i += 1) |> (await later(%), getters.push(() => %), % < 3));
  return values(getters);
}
export async function doTest() {
  const getters: (() => number)[] = [];
  let i = 0;
  let ran = 0;
  do {
    ran += 1;
    if (ran === 2) continue;
  } while ((i += 1) |> (await later(%), getters.push(() => %), % < 3));
  return [ran, ...values(getters)];
}
export async function forUpdate() {
  const getters: (() => number)[] = [];
  outer: for (const a of [10, 20])
    for (let b = 0; b < 2; b = b |> (await later(%), getters.push(() => a + %), % + 1)) {
      if (b === 1) continue outer;
    }
  return values(getters);
}
export async function methods() {
  const objects: { get v(): number }[] = [];
  for (const id of [1, 2, 3]) objects.push(id |> (await later(%), { get v() { return %; } }));
  return objects.map((object) => object.v);
}
export function* generator(): Generator<number, number[], number> {
  const getters: (() => number)[] = [];
  let i = 0;
  while ((i += 1) |> ((yield %), getters.push(() => %), % < 3));
  return values(getters);
}
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const exports = evaluate(generated);
    const call = (name: string) => (exports[name] as () => Promise<unknown>)();
    await expect(call("block")).resolves.toEqual([1, 2, 3]);
    await expect(call("bare")).resolves.toEqual([1, 2, 3]);
    await expect(call("whileTest")).resolves.toEqual([1, 2, 3]);
    // `continue` in a `do` body still runs the test.
    await expect(call("doTest")).resolves.toEqual([3, 1, 2, 3]);
    await expect(call("forUpdate")).resolves.toEqual([10, 20]);
    await expect(call("methods")).resolves.toEqual([1, 2, 3]);
    const generator = (
      exports["generator"] as () => Generator<number, number[], number>
    )();
    const yielded: number[] = [];
    let step = generator.next();
    while (step.done !== true) {
      yielded.push(step.value);
      step = generator.next(0);
    }
    expect(yielded).toEqual([1, 2, 3]);
    expect(step.value).toEqual([1, 2, 3]);
  });

  test("reports an object literal that waits and has a method reading the topic", () => {
    const { messages } = run(
      hack,
      `${hackImport}
export const make = async (id: number) =>
  id |> { value: await Promise.resolve(%), get same() { return %; } };
`,
    );
    expect(messages).toEqual([
      "TS4023: This object literal waits, with `await` or `yield`, and has a method that reads a value a macro evaluated once for it. The method cannot be given its own copy of that value; move the `await` or `yield` out of the object literal.",
    ]);
  });

  test("refuses a body that never uses the topic", () => {
    const { messages } = run(
      hack,
      `${hackImport}
const foo = 1;
export const value = 1 |> foo + 1;
`,
    );
    expect(messages).toEqual([
      "TS4022: This must use %, and does not. The macro gives % a meaning here only for syntax that uses it.",
    ]);
  });

  test.each([
    ["a conditional", "1 |> % ? 1 : 2"],
    ["an arrow function", "1 |> (x: number) => % + x"],
    ["an assignment", "1 |> y = %"],
  ])("refuses %s as an unparenthesized body", (_, expression) => {
    const { messages } = run(
      hack,
      `${hackImport}
let y = 0;
export const value = ${expression};
`,
    );
    // One error for the pipe, and none for the `%` it never gave a meaning.
    expect(messages).toEqual([
      "TS4001: No rule for macro |> accepted this input: an expression that is not an unparenthesized arrow function, an unparenthesized assignment, an unparenthesized conditional or an unparenthesized `yield`.",
    ]);
  });

  test("refuses an unparenthesized `yield` as a body", () => {
    const { messages } = run(
      hack,
      `${hackImport}
export function* g(): Generator<number, number, number> {
  const received = 1 |> yield %;
  return received;
}
`,
    );
    expect(messages).toEqual([
      "TS4001: No rule for macro |> accepted this input: an expression that is not an unparenthesized arrow function, an unparenthesized assignment, an unparenthesized conditional or an unparenthesized `yield`.",
    ]);
  });

  test("binds as loosely as a conditional's branches and an assignment", () => {
    const { generated, messages } = run(
      hack,
      `${hackImport}
export let assigned = 0;
export const branch = false ? 0 : 5 |> % + 1;
export const nullish = (undefined as number | undefined) ?? 3 |> % * 2;
export const body = 2 |> % ?? 9;
assigned = 4 |> % * 4;
export const read = () => assigned;
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["branch"]).toBe(6);
    expect(exports["nullish"]).toBe(6);
    expect(exports["body"]).toBe(2);
    expect((exports["read"] as () => number)()).toBe(16);
  });
});

describe("what the pipes needed that was broken", () => {
  test("an operator rule that matches only part of its operands is not taken", () => {
    const { messages } = run(
      `
export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 35;
  rule { $value:expr |> await } => { await $value }
}
`,
      `${fsharpImport}
declare const g: number;
export const value = async () => 1 |> await g;
`,
    );
    // Matched, it would expand to \`await 1\`, dropping \`g\`.
    expect(messages.join("\n")).toContain("No rule for macro |>");
  });

  test("an operator whose right side is a keyword does not recurse without end", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
declare const p: Promise<number>;
const f = (n: number) => n + 1;
export const value = async () => p |> await |> f;
`,
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("await p");
  });

  test("a captured conditional or arrow keeps its grouping in a template", () => {
    const { generated, messages } = run(
      `
export syntax twice:expr { rule { twice($v:expr) } => { $v * 2 } }
export syntax callOne:expr { rule { callOne($f:expr) } => { $f(1) } }
`,
      `import { twice, callOne } from "./macros.sts" for syntax;
declare const flag: boolean;
export const doubled = twice(flag ? 1 : 2);
export const called = callOne((n: number) => n + 1);
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(
      generated.replace("declare const flag: boolean;", "const flag = true;"),
    );
    expect(exports["doubled"]).toBe(2);
    expect(exports["called"]).toBe(2);
  });

  test("an operator's operands keep their grouping at the top level", () => {
    const { generated, messages } = run(
      `
export operator (|>>):expr {
  fixity infix;
  associativity left;
  precedence 35;
  rule { $value:expr |>> $factor:expr } => { $value * $factor }
}
`,
      `import { (|>>) } from "./macros.sts" for syntax;
export const product = 1 + 2 |>> 3 + 4;
export function inBody() { return 1 + 2 |>> 3 + 4; }
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["product"]).toBe(21);
    expect((exports["inBody"] as () => number)()).toBe(21);
  });

  test("an arrow body prints without parentheses it does not need", () => {
    const { generated, messages } = run(
      `
export syntax twice:expr { rule { twice($v:expr) } => { $v * 2 } }
`,
      `import { twice } from "./macros.sts" for syntax;
export const scaled = (value: number) => twice(value) + 1;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated)["scaled"]).toBeTypeOf("function");
    expect((evaluate(generated)["scaled"] as (n: number) => number)(3)).toBe(7);
  });

  test("a `yield` in a macro's argument is read inside a generator", () => {
    const { generated, messages } = run(
      "export syntax twice:expr { rule { twice($v:expr) } => { $v * 2 } }",
      `import { twice } from "./macros.sts" for syntax;
export function* g(): Generator<number, number, number> {
  const received = twice(yield 1);
  return received;
}
`,
    );
    expect(messages).toEqual([]);
    const generator = (
      evaluate(generated)["g"] as () => Generator<number, number, number>
    )();
    expect(generator.next()).toEqual({ value: 1, done: false });
    expect(generator.next(4)).toEqual({ value: 8, done: true });
  });

  test("a contextual keyword is an operand", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const double = (n: number) => n * 2;
export const value = (from: number, of: number) => from |> double |> ((n) => n + of);
`,
    );
    expect(messages).toEqual([]);
    expect(
      (evaluate(generated)["value"] as (a: number, b: number) => number)(3, 1),
    ).toBe(7);
  });

  test("an operator in a control statement's header is expanded", async () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const positive = (n: number) => n > 0;
const double = (n: number) => n * 2;
export async function walk(start: number, items: number[]) {
  const seen: number[] = [];
  if (start |> positive) seen.push(start);
  let n = start;
  while (n |> positive) n -= 1;
  do n += 1; while (n |> double |> ((m) => m < 4));
  for (let i = 0; i |> ((j) => j < 2); i = i |> ((j) => j + 1)) seen.push(i);
  for (const item of items |> ((list) => list.slice(1))) seen.push(item);
  for await (const item of [Promise.resolve(9)] |> ((list) => list)) seen.push(item);
  switch (start |> double) { case 4: seen.push(-1); }
  return [n, ...seen];
}
`,
    );
    expect(messages).toEqual([]);
    expect(typeErrors(generated)).toEqual([]);
    const walk = evaluate(generated)["walk"] as (
      start: number,
      items: number[],
    ) => Promise<number[]>;
    await expect(walk(2, [7, 8])).resolves.toEqual([2, 2, 0, 1, 8, 9, -1]);
  });

  test("an operator in an object literal's method is expanded", () => {
    const { generated, messages } = run(
      fsharp,
      `${fsharpImport}
const double = (n: number) => n * 2;
export const object = { method(n: number) { return n |> double; } };
`,
    );
    expect(messages).toEqual([]);
    expect(
      (evaluate(generated)["object"] as { method(n: number): number }).method(
        4,
      ),
    ).toBe(8);
  });
  test("an operator's operand clause is checked", () => {
    for (const [clauses, problem] of [
      [
        "fixity infix; associativity left; precedence 5; operand block;",
        "operand must be arrow",
      ],
      [
        "fixity prefix; precedence 5; operand arrow;",
        "only an infix operator takes operand arrow",
      ],
    ] as const) {
      const { messages } = run(
        `export operator (~~>):expr { ${clauses} rule { $a:expr ~~> $b:expr } => { $b($a) } }`,
        "export const value = 1;\n",
      );
      expect(messages.join("\n")).toContain(problem);
    }
  });
});

describe("#let", () => {
  const once = `
export syntax twice:expr {
  rule { twice($value:expr) } => {
    #let(value = $value) { value + value }
  }
}
`;

  test("evaluates its value once", () => {
    const { generated, messages } = run(
      once,
      `import { twice } from "./macros.sts" for syntax;
export let calls = 0;
export const value = twice((calls += 1));
export const read = () => calls;
`,
    );
    expect(messages).toEqual([]);
    const exports = evaluate(generated);
    expect(exports["value"]).toBe(2);
    expect((exports["read"] as () => number)()).toBe(1);
  });

  test("declares its variable where an `await` in the value's use needs it", async () => {
    const macros = `
export syntax plusLater:expr {
  rule { plusLater($value:expr, $later:expr) } => {
    #let(value = $value) { value + await $later }
  }
}
`;
    const topLevel = run(
      macros,
      `import { plusLater } from "./macros.sts" for syntax;
export const inArrow = async (n: number) => plusLater(n, Promise.resolve(1));
export const atTopLevel = plusLater(2, Promise.resolve(3));
`,
    );
    expect(topLevel.messages).toEqual([]);
    expect(typeErrors(topLevel.generated)).toEqual([]);
    // The module and the arrow each declare their own.
    expect(topLevel.generated.match(/let value/gu)).toHaveLength(2);
    const inArrow = run(
      macros,
      `import { plusLater } from "./macros.sts" for syntax;
export const inArrow = async (n: number) => plusLater(n, Promise.resolve(1));
`,
    );
    expect(inArrow.messages).toEqual([]);
    const add = evaluate(inArrow.generated)["inArrow"] as (
      n: number,
    ) => Promise<number>;
    await expect(add(4)).resolves.toBe(5);
  });
});
