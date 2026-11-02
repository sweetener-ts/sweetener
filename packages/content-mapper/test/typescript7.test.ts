import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { check, LanguageServerClient, mappedProject } from "./typescript7.js";

/**
 * The mapper under the TypeScript it was written for: the 7.1 beta this
 * package pins, starting `dist/src/server.js` the way it would for a user.
 */

const macros = `export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 40;
  rule { $value:expr |> $callee:ident } => { $callee($value) }
}
`;

const main = `import { (|>) } from "./macros.sts" for syntax;

const trim = (value: string) => value.trim();
const shout = (value: string) => value.toUpperCase();
export const result = "  hello  " |> trim |> shout;
`;

describe("tsc", () => {
  test("checks a project that expands cleanly", () => {
    const { directory } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
      "use.ts": `import { result } from "./main.sts";\nexport const loud: string = result;\n`,
    });
    expect(check(directory)).toEqual({ status: 0, lines: [] });
  });

  test("reports type errors in expanded code where the author wrote them", () => {
    const { directory } = mappedProject({
      "macros.sts": macros,
      "main.sts": `${main}export const n: number = 5 |> trim;\n`,
      "use.ts": `import { result } from "./main.sts";\nexport const x: number = result;\n`,
    });
    expect(check(directory).lines).toEqual([
      "src/main.sts(6,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/main.sts(6,26): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
      "src/use.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
  });

  test("checks JSX sources as TSX", () => {
    const view = [
      `import { (|>) } from "./macros.sts" for syntax;`,
      `declare global { namespace JSX { interface IntrinsicElements { b: { title: string } } } }`,
      `declare function h(...args: unknown[]): unknown;`,
      `const trim = (value: string) => value.trim();`,
      `export const view = <b title={"  x  " |> trim} />;`,
      `export const wrong = <b title={5 |> trim} />;`,
      ``,
    ].join("\n");
    const { directory } = mappedProject(
      { "macros.sts": macros, "view.stsx": view },
      { jsx: "react", jsxFactory: "h" },
    );
    expect(check(directory).lines).toEqual([
      "src/view.stsx(6,32): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
    ]);
  });

  test("says why when a config is unusable, rather than that the mapper failed", () => {
    const { directory } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
    });
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, "utf8")),
        sweet: { bogus: true },
      }),
    );
    const lines = check(directory).lines;
    expect(
      lines.some((line) =>
        line.includes("sweet.bogus is not a recognized option"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("failed to transform"))).toBe(
      false,
    );
  });

  test("expands a directory linked in under the project", () => {
    const { directory } = mappedProject({
      "main.sts": `import { one } from "./shared/x.sts" for syntax;\nexport const a: string = one;\n`,
    });
    const shared = realpathSync(mkdtempSync(join(tmpdir(), "sweet-shared-")));
    writeFileSync(
      join(shared, "x.sts"),
      "export syntax one:expr { rule { one } => { 1 } }\n",
    );
    symlinkSync(shared, join(directory, "src", "shared"), "dir");
    expect(check(directory).lines).toEqual([
      "src/main.sts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.",
    ]);
  });

  test("checks a file holding bytes that are not UTF-8", () => {
    const { directory, file } = mappedProject({
      "main.sts": "export const n: string = 1;\n",
    });
    writeFileSync(
      file("bad.sts"),
      Buffer.concat([
        Buffer.from('export const s = "'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('";\nexport const t: string = 1;\n'),
      ]),
    );
    const { lines } = check(directory);
    expect(lines.filter((line) => line.includes("18073"))).toEqual([]);
    expect(lines).toContain(
      "src/main.sts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.",
    );
    expect(lines).toContain(
      "src/bad.sts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.",
    );
  });

  test("accepts an option only TypeScript 7 knows", () => {
    const { directory } = mappedProject(
      { "macros.sts": macros, "main.sts": main },
      { checkers: 2 },
    );
    expect(check(directory)).toEqual({ status: 0, lines: [] });
  });

  test("reports what expansion could not do under Sweetener's name", () => {
    const { directory } = mappedProject({
      "macros.sts": macros,
      "main.sts": `import { (|>) } from "./macros.sts" for syntax;\nexport const bad = 5 |> ;\n`,
    });
    expect(check(directory).lines).toContain(
      "src/main.sts(2,22): error SWR4021: Operator |> was left unexpanded: the expression it is written in could not be read, so none of its rules were tried.",
    );
  });
});

describe("the language server", () => {
  let client: LanguageServerClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  const position = (text: string, needle: string, from = 0) => {
    const offset = text.indexOf(needle, from);
    const before = text.slice(0, offset).split("\n");
    return { line: before.length - 1, character: before.at(-1)!.length };
  };

  test("hover, definition, and rename reach through an invocation", async () => {
    const { directory, file } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), main);
    const uri = pathToFileURL(file("main.sts")).href;
    const shoutUse = position(main, "shout", main.indexOf("|> shout"));

    const hover = (await client.request("textDocument/hover", {
      textDocument: { uri },
      position: shoutUse,
    })) as { contents: { value: string } };
    expect(hover.contents.value).toBe("const shout: (value: string) => string");

    const definition = (await client.request("textDocument/definition", {
      textDocument: { uri },
      position: shoutUse,
    })) as { uri: string; range: { start: unknown } }[];
    expect(definition).toEqual([
      expect.objectContaining({
        uri,
        range: expect.objectContaining({ start: position(main, "shout") }),
      }),
    ]);

    const references = (await client.request("textDocument/references", {
      textDocument: { uri },
      position: shoutUse,
      context: { includeDeclaration: true },
    })) as { range: { start: unknown } }[];
    expect(references.map(({ range }) => range.start)).toEqual([
      position(main, "shout"),
      shoutUse,
    ]);

    const rename = (await client.request("textDocument/rename", {
      textDocument: { uri },
      position: position(main, "trim"),
      newName: "strip",
    })) as { changes: Record<string, { range: { start: unknown } }[]> };
    expect(rename.changes[uri]!.map(({ range }) => range.start)).toEqual([
      position(main, "trim ="),
      position(main, "trim", main.indexOf("|> trim")),
    ]);
  });

  test("renames a name a macro copied twice when both copies are one binding", async () => {
    const pair = `import { twice } from "./twice.sts" for syntax;\nconst value = 21;\nexport const both = twice(value);\n`;
    const { directory, file } = mappedProject({
      "twice.sts": `export syntax twice:expr { rule { twice($value:expr) } => { [$value, $value] } }\n`,
      "pair.sts": pair,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("pair.sts"), pair);
    const uri = pathToFileURL(file("pair.sts")).href;
    const rename = (await client.request("textDocument/rename", {
      textDocument: { uri },
      position: position(pair, "value", pair.indexOf("twice(value")),
      newName: "renamed",
    })) as { changes: Record<string, { range: { start: unknown } }[]> };
    expect(rename.changes[uri]!.map(({ range }) => range.start)).toEqual([
      position(pair, "value"),
      position(pair, "value", pair.indexOf("twice(value")),
    ]);
  });

  test("will not rename through copies that name different bindings", async () => {
    const main = `import { shadow } from "./shadow.sts" for syntax;\nconst x = 5;\nexport const r = shadow(x, x + 1);\n`;
    const { directory, file } = mappedProject({
      "shadow.sts": `export syntax shadow:expr { rule { shadow($x:ident, $body:expr) } => { [$x, (($x) => $body)(0)] } }\n`,
      "main.sts": main,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), main);
    const uri = pathToFileURL(file("main.sts")).href;
    const captured = position(main, "x", main.indexOf("shadow("));
    await expect(
      client.request("textDocument/prepareRename", {
        textDocument: { uri },
        position: captured,
      }),
    ).rejects.toThrow(/cannot rename this element/u);
    // Started at the outer declaration, the rename cannot write through the
    // captured copy; what it leaves behind is an error TypeScript reports.
    const rename = (await client.request("textDocument/rename", {
      textDocument: { uri },
      position: position(main, "x ="),
      newName: "renamed",
    })) as { changes: Record<string, { range: { start: unknown } }[]> };
    expect(rename.changes[uri]!.map(({ range }) => range.start)).toEqual([
      position(main, "x ="),
    ]);
  });

  test("answers about unsaved text", async () => {
    const broken = `${main}export const n: number = 5 |> trim;\n`;
    const { directory, file } = mappedProject({
      "macros.sts": macros,
      "main.sts": broken,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), broken);
    expect(await client.diagnostics(file("main.sts"))).toEqual([
      "6:14 2322 Type 'string' is not assignable to type 'number'.",
      "6:26 2345 Argument of type 'number' is not assignable to parameter of type 'string'.",
    ]);
    client.change(
      file("main.sts"),
      2,
      broken.replace("n: number = 5", `n: string = "5"`),
    );
    expect(await client.diagnostics(file("main.sts"))).toEqual([]);
  });

  test("an unsaved change to a macro reaches a file that uses it when that file is edited", async () => {
    const { directory, file } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), main);
    client.open(file("macros.sts"), macros);
    expect(await client.diagnostics(file("main.sts"))).toEqual([]);
    client.change(
      file("macros.sts"),
      2,
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    // TypeScript transforms again only the file whose text changed, and the
    // protocol has no way to say that another file read it.
    await client.diagnostics(file("macros.sts"));
    client.change(file("main.sts"), 2, `${main}\n`);
    expect(await client.diagnostics(file("main.sts"))).toEqual([
      "5:35 2554 Expected 1 arguments, but got 2.",
      "5:43 2554 Expected 1 arguments, but got 2.",
    ]);
  });

  test("an unsaved change to a macro reaches a file that uses it at the next edit of the module", async () => {
    const { directory, file } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), main);
    client.open(file("macros.sts"), macros);
    expect(await client.diagnostics(file("main.sts"))).toEqual([]);
    const changed = macros.replace("$callee($value)", "$callee($value, 1)");
    client.change(file("macros.sts"), 2, changed);
    await client.diagnostics(file("macros.sts"));
    // TypeScript asks for the project's identity before it transforms the
    // edited module, so the edit after it is the one that carries it.
    client.change(file("macros.sts"), 3, `${changed}\n`);
    await client.diagnostics(file("macros.sts"));
    expect(await client.diagnostics(file("main.sts"))).toEqual([
      "5:35 2554 Expected 1 arguments, but got 2.",
      "5:43 2554 Expected 1 arguments, but got 2.",
    ]);
  });

  test("will not write an expanded rename into a macro's input", async () => {
    const shorthand = `export syntax obj:expr { rule { obj($x:ident) } => { ({ $x }) } }\n`;
    const use = `import { obj } from "./macros.sts" for syntax;\nconst foo = 1;\nexport const o = obj(foo);\n`;
    const { directory, file } = mappedProject({
      "macros.sts": shorthand,
      "main.sts": use,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), use);
    expect(await client.diagnostics(file("main.sts"))).toEqual([]);
    const edit = (await client.request("textDocument/rename", {
      textDocument: { uri: pathToFileURL(file("main.sts")).href },
      position: { line: 1, character: 6 },
      newName: "renamed",
    })) as {
      changes?: Record<string, { newText: string }[]>;
      documentChanges?: { edits: { newText: string }[] }[];
    } | null;
    const written = [
      ...Object.values(edit?.changes ?? {}).flat(),
      ...(edit?.documentChanges ?? []).flatMap(({ edits }) => edits),
    ].map(({ newText }) => newText);
    expect(written.filter((text) => text.includes(":"))).toEqual([]);
  });

  test("formats a file as TypeScript does, writing each edit once", async () => {
    const text = "function f( x:number ){  return x+1  }\nexport { f };\n";
    const { directory, file } = mappedProject({ "main.sts": text });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), text);
    await client.diagnostics(file("main.sts"));
    const edits = (await client.request("textDocument/formatting", {
      textDocument: { uri: pathToFileURL(file("main.sts")).href },
      options: { tabSize: 2, insertSpaces: true },
    })) as {
      newText: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }[];
    const lines = text.split("\n");
    const at = ({ line, character }: { line: number; character: number }) =>
      lines.slice(0, line).reduce((sum, each) => sum + each.length + 1, 0) +
      character;
    const formatted = [...edits]
      .sort((left, right) => at(right.range.start) - at(left.range.start))
      .reduce(
        (result, { newText, range }) =>
          result.slice(0, at(range.start)) +
          newText +
          result.slice(at(range.end)),
        text,
      );
    expect(formatted).toBe(
      "function f(x: number) { return x + 1 }\nexport { f };\n",
    );
  });

  test("will not double an edit through text a macro copied", async () => {
    const twice = `export syntax twice:expr { rule { twice($v:expr) } => { [$v, $v] } }\n`;
    const use = `import { twice } from "./macros.sts" for syntax;\nexport const o = twice(  1+2  );\n`;
    const { directory, file } = mappedProject({
      "macros.sts": twice,
      "main.sts": use,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), use);
    await client.diagnostics(file("main.sts"));
    const edits = (await client.request("textDocument/formatting", {
      textDocument: { uri: pathToFileURL(file("main.sts")).href },
      options: { tabSize: 2, insertSpaces: true },
    })) as { range: { start: unknown; end: unknown } }[] | null;
    const places = (edits ?? []).map(({ range }) => JSON.stringify(range));
    expect(new Set(places).size).toBe(places.length);
  });

  test("hears a file saved that the project did not list, when the project next opens", async () => {
    const { directory, file } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
    });
    const text = "export const n = 1;\n";
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), main);
    client.open(file("macros.sts"), macros);
    await client.diagnostics(file("main.sts"));
    client.open(file("new.sts"), text);
    expect(await client.diagnostics(file("new.sts"))).toEqual([
      expect.stringContaining("6202"),
    ]);
    // TypeScript takes no event for a file open in the editor, which it holds
    // itself. A change to a file it watches opens the project.
    writeFileSync(file("new.sts"), text);
    client.change(file("macros.sts"), 2, `${macros}\n`);
    await client.diagnostics(file("macros.sts"));
    expect(await client.diagnostics(file("new.sts"))).toEqual([]);
  });

  test("a saved change to a macro re-expands the files that use it", async () => {
    const { directory, file } = mappedProject({
      "macros.sts": macros,
      "main.sts": main,
    });
    client = await LanguageServerClient.start(directory);
    client.open(file("main.sts"), main);
    expect(await client.diagnostics(file("main.sts"))).toEqual([]);
    writeFileSync(
      file("macros.sts"),
      readFileSync(file("macros.sts"), "utf8").replace(
        "$callee($value)",
        "$callee($value, 1)",
      ),
    );
    client.notify("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(file("macros.sts")).href, type: 2 }],
    });
    expect(await client.diagnostics(file("main.sts"))).toEqual([
      "5:35 2554 Expected 1 arguments, but got 2.",
      "5:43 2554 Expected 1 arguments, but got 2.",
    ]);
  });
});
