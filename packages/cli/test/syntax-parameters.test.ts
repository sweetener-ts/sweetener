import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Syntax parameters, after Racket's `define-syntax-parameter` and
 * `syntax-parameterize`.
 *
 * A syntax parameter is a macro binding whose meaning a template can adjust
 * for the syntax it wraps. `#parameterize(% = topic) { body }` makes every `%`
 * that refers to the parameter, anywhere in the expansion of `body`, stand for
 * `topic` -- including a `%` the user wrote in a capture. That is what a Hack
 * pipe needs: its right side mentions a placeholder the pipe binds, and
 * hygiene alone cannot connect a name the user wrote to a name a template
 * introduced.
 */

const pipe = `
export syntax parameter (%):expr;

export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 40;

  rule { $value:expr |> $body:expr } => {
    ((topic) => #parameterize(% = topic) { $body })($value)
  }
}
`;

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-syntax-parameters-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, target: "ES2022" },
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

/** Runs the expansion and returns what one exported binding computes. */
function evaluate(generated: string, name: string): unknown {
  const javascript = ts.transpileModule(generated, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("exports", javascript)(exports);
  return exports[name];
}

const pipeImport = 'import { (|>), (%) } from "./macros.sts" for syntax;\n';

describe("a Hack pipe written with a syntax parameter", () => {
  test("the placeholder may stand anywhere an operand may", () => {
    const { generated, messages } = run(
      pipe,
      `${pipeImport}
const add = (a: number, b: number) => a + b;
export const call = 1 |> add(2, %);
export const leading = 3 |> % * 10;
export const chained = 1 |> % + 1 |> [%, 0] |> ({ first: %[0] });
export const method = "hi" |> %.toUpperCase() |> \`\${%}!\`;
export const negated = true |> !%;
class Box { constructor(readonly value: number) {} }
export const constructed = 5 |> new Box(%) |> %.value;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "call")).toBe(3);
    expect(evaluate(generated, "leading")).toBe(30);
    expect(evaluate(generated, "chained")).toEqual({ first: 2 });
    expect(evaluate(generated, "method")).toBe("HI!");
    expect(evaluate(generated, "negated")).toBe(false);
    expect(evaluate(generated, "constructed")).toBe(5);
  });

  test("a % between operands is still the remainder", () => {
    const { generated, messages } = run(
      pipe,
      `${pipeImport}
export const remainder = 7 % 3;
export const both = 7 |> % % 4;
export function inBody(value: number) { return value % 2; }
export const called = inBody(5);
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "remainder")).toBe(1);
    expect(evaluate(generated, "both")).toBe(3);
    expect(evaluate(generated, "called")).toBe(1);
  });

  test("the pipe's own binding does not capture the call site's", () => {
    const { generated, messages } = run(
      pipe,
      `${pipeImport}
const topic = 100;
export const sum = 1 |> % + topic;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "sum")).toBe(101);
  });

  test("an inner pipe rebinds the placeholder only for its own body", () => {
    const { generated, messages } = run(
      pipe,
      `${pipeImport}
export const nested = 1 |> (% |> % + 1) * 10;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "nested")).toBe(20);
  });

  test("a pipe works in a function body", () => {
    const { generated, messages } = run(
      pipe,
      `${pipeImport}
export function twice(value: number) {
  const doubled = value |> % * 2;
  return doubled |> [%, %];
}
export const pair = twice(4);
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "pair")).toEqual([8, 8]);
  });

  test("a placeholder outside any pipe is reported where it is written", () => {
    const { messages } = run(
      pipe,
      `${pipeImport}
export const stray = % + 1;
`,
    );
    expect(messages.join("\n")).toContain(
      "Syntax parameter % is used outside any #parameterize",
    );
    expect(messages.join("\n")).not.toContain("Project expansion failed");
  });
});

describe("syntax parameters in general", () => {
  const withDefault = `
export syntax parameter it:expr {
  rule { it } => { "default" }
}

export syntax withIt:expr {
  rule { withIt($value:expr, $body:expr) } => {
    ((bound) => #parameterize(it = bound) { $body })($value)
  }
}
`;

  test("an unparameterized use takes the parameter's own rules", () => {
    const { generated, messages } = run(
      withDefault,
      `import { it, withIt } from "./macros.sts" for syntax;
export const outside = it;
export const inside = withIt(41, it + 1);
export const restored = [withIt(1, it), it];
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "outside")).toBe("default");
    expect(evaluate(generated, "inside")).toBe(42);
    expect(evaluate(generated, "restored")).toEqual([1, "default"]);
  });

  test("a parameterization reaches macros expanded inside its body", () => {
    const { generated, messages } = run(
      `${withDefault}
export syntax usesIt:expr {
  rule { usesIt() } => { [it, it] }
}
`,
      `import { it, withIt, usesIt } from "./macros.sts" for syntax;
export const pair = withIt(7, usesIt());
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "pair")).toEqual([7, 7]);
  });

  test("a parameter may be spelled with punctuation the scanner splits", () => {
    const { generated, messages } = run(
      `
export syntax parameter (^^):expr;
export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 40;
  rule { $value:expr |> $body:expr } => {
    ((topic) => #parameterize(^^ = topic) { $body })($value)
  }
}
`,
      `import { (|>), (^^) } from "./macros.sts" for syntax;
export const value = 6 |> ^^ + 1 |> [^^, ^^ ^ 1];
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "value")).toEqual([7, 6]);
  });

  test("a template may write the parameter itself, beside a remainder", () => {
    const { generated, messages } = run(
      `
export syntax parameter (%):expr;
export syntax parity:expr {
  rule { parity($value:expr) } => {
    ((n) => #parameterize(% = n) { [% % 2, (%), f(%)] })($value)
  }
}
`,
      `import { parity } from "./macros.sts" for syntax;
const f = (value: number) => value * 10;
export const result = parity(7);
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "result")).toEqual([1, 7, 70]);
  });

  test("a replacement means the parameterization around it, not itself", () => {
    const { generated, messages } = run(
      `
export syntax parameter it:expr;
export syntax withIt:expr {
  rule { withIt($value:expr, $body:expr) } => {
    ((bound) => #parameterize(it = bound) { $body })($value)
  }
}
export syntax pairIt:expr {
  rule { pairIt($body:expr) } => {
    #parameterize(it = [it, it]) { $body }
  }
}
`,
      `import { it, withIt, pairIt } from "./macros.sts" for syntax;
export const value = withIt(2, pairIt(it));
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "value")).toEqual([2, 2]);
  });

  test("a required parameterization reports a body that never uses it", () => {
    const macros = `
export syntax parameter it:expr;
export syntax withIt:expr {
  rule { withIt($value:expr, $body:expr) } => {
    ((bound) => #parameterize(required it = bound) { $body })($value)
  }
}
export syntax usesIt:expr {
  rule { usesIt() } => { it }
}
`;
    const unused = run(
      macros,
      `import { it, withIt } from "./macros.sts" for syntax;
export const value = withIt(1, 2);
`,
    );
    expect(unused.messages).toEqual([
      "TS4022: This must use it, and does not. The macro gives it a meaning here only for syntax that uses it.",
    ]);
    // A use inside a macro the body expands counts.
    const throughMacro = run(
      macros,
      `import { it, withIt, usesIt } from "./macros.sts" for syntax;
export const value = withIt(3, usesIt());
`,
    );
    expect(throughMacro.messages).toEqual([]);
    expect(evaluate(throughMacro.generated, "value")).toBe(3);
    // A use belongs to the nearest parameterization, so the outer one here is
    // unused.
    const shadowed = run(
      macros,
      `import { it, withIt } from "./macros.sts" for syntax;
export const value = withIt(1, withIt(2, it));
`,
    );
    expect(shadowed.messages).toEqual([
      "TS4022: This must use it, and does not. The macro gives it a meaning here only for syntax that uses it.",
    ]);
  });

  test("a parameter named required is the whole name", () => {
    const { generated, messages } = run(
      `
export syntax parameter required:expr;
export syntax withRequired:expr {
  rule { withRequired($body:expr) } => {
    #parameterize(required = 5) { $body }
  }
}
`,
      `import { required, withRequired } from "./macros.sts" for syntax;
export const value = withRequired(required + 1);
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "value")).toBe(6);
  });

  test("a macro may still be named parameter", () => {
    const { generated, messages } = run(
      "export syntax parameter:expr { rule { parameter } => { 5 } }",
      `import { parameter } from "./macros.sts" for syntax;
export const value = parameter;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "value")).toBe(5);
  });

  test("a syntax parameter declared inside a block is reported", () => {
    const { messages } = run(
      pipe,
      `${pipeImport}
export function f() { syntax parameter (^^):expr; return 1; }
`,
    );
    expect(messages.join("\n")).toContain(
      "so ^^ written inside a block was not processed",
    );
  });

  test("#parameterize of a name that is not a syntax parameter is reported", () => {
    const { messages } = run(
      `
export syntax plain:expr { rule { plain } => { 1 } }
export syntax wrong:expr {
  rule { wrong($body:expr) } => { #parameterize(plain = 2) { $body } }
}
`,
      `import { plain, wrong } from "./macros.sts" for syntax;
export const value = wrong(plain);
`,
    );
    expect(messages.join("\n")).toContain(
      "#parameterize names plain, which is not a syntax parameter",
    );
  });
});

describe("what a pipe needed that was broken", () => {
  test("a helper macro in an operator's template needs no import at the use site", () => {
    const { generated, messages } = run(
      `
export syntax helper:expr {
  rule { helper($value:expr) } => { [$value, $value] }
}

export operator (|>>):expr {
  fixity infix;
  associativity left;
  precedence 40;
  rule { $value:expr |>> $callee:ident } => { $callee(helper($value)) }
}
`,
      `import { (|>>) } from "./macros.sts" for syntax;
const first = (pair: number[]) => pair[0];
export const value = 3 |>> first;
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "value")).toBe(3);
  });

  test("an operator in a template needs no import at the use site", () => {
    const { generated, messages } = run(
      `
export operator (|>>):expr {
  fixity infix;
  associativity left;
  precedence 40;
  rule { $value:expr |>> $callee:ident } => { $callee($value) }
}

export syntax double:expr {
  rule { double($value:expr) } => { $value |>> twice }
}
`,
      `import { double } from "./macros.sts" for syntax;
const twice = (value: number) => value * 2;
export const value = double(4);
`,
    );
    expect(messages).toEqual([]);
    expect(evaluate(generated, "value")).toBe(8);
  });

  test("an unreadable template literal substitution is a diagnostic, not a crash", () => {
    const { messages } = run(
      pipe,
      'import { (|>) } from "./macros.sts" for syntax;\nexport const b = `${%}`;\n',
    );
    expect(messages.join("\n")).not.toContain("Project expansion failed");
    expect(messages.some((message) => message.startsWith("TS4"))).toBe(true);
  });

  test("an unreadable operator operand inside parentheses is a diagnostic, not a crash", () => {
    const { messages } = run(
      pipe,
      'import { (|>) } from "./macros.sts" for syntax;\nexport const s = (1 |> ) ;\n',
    );
    expect(messages.join("\n")).not.toContain("Project expansion failed");
    expect(messages.join("\n")).toContain("|>");
  });

  test("an operator left unexpanded in a declaration is reported", () => {
    const { messages } = run(
      pipe,
      'import { (|>) } from "./macros.sts" for syntax;\nexport const s = 1 |> ;\n',
    );
    expect(messages.join("\n")).toContain("Operator |> was left unexpanded");
  });

  test("an operator left unexpanded in a function body is reported", () => {
    const { messages } = run(
      pipe,
      'import { (|>) } from "./macros.sts" for syntax;\nexport function f() { return 1 |> ; }\n',
    );
    expect(messages.join("\n")).toContain("Operator |> was left unexpanded");
  });
});
