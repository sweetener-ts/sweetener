import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultProjectExpansionProvider,
  InputCheckRound,
  loadSweetProject,
  typescript as ts,
} from "@sweetener/compiler";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBindingAgreement } from "../src/binding-agreement.js";
import { ResponseError } from "../src/json-rpc.js";
import { SweetenerContentMapper } from "../src/mapper.js";
import {
  compatibleSegments,
  offsetEncoder,
  type Segment,
} from "../src/span-mappings.js";
import {
  SpanMapFeature,
  SpanMapKind,
  type OpenProjectResult,
  type TransformResult,
} from "../src/protocol.js";
import { spanMapProblem } from "./span-map-rules.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const macros = `export operator (|>):expr {
  fixity infix;
  associativity left;
  precedence 40;
  rule { $value:expr |> $callee:ident } => { $callee($value) }
}
`;

const main = `import { (|>) } from "./macros.sts" for syntax;

const trim = (value: string) => value.trim();
export const result = "  hello  " |> trim;
`;

function project(files: Record<string, string> = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sweet-mapper-")));
  const all = { "macros.sts": macros, "main.sts": main, ...files };
  for (const [name, text] of Object.entries(all))
    writeFileSync(join(directory, name), text);
  const config = join(directory, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022", strict: true },
      contentMappers: [
        { package: "@sweetener/content-mapper", extensions: [".sts"] },
      ],
      include: ["*.sts"],
    }),
  );
  return { directory, config, file: (name: string) => join(directory, name) };
}

function opened(config: string) {
  const mapper = new SweetenerContentMapper();
  mapper.initialize({
    protocolVersion: 1,
    positionEncodings: ["utf-8", "utf-16"],
  });
  const result = mapper.openProject({
    configFileName: config,
    projectHandle: "p",
    compilerOptions: {},
  });
  const transform = (
    fileName: string,
    content = readFileSync(fileName, "utf8"),
  ) => mapper.transform({ fileName, content, projectHandle: "p" });
  return { mapper, result, transform };
}

function expectAcceptable(result: TransformResult, original: string) {
  expect(
    spanMapProblem(result.mappings, result.text, original),
  ).toBeUndefined();
}

describe("initialize", () => {
  test("negotiates UTF-16 when offered and names its diagnostics", () => {
    expect(
      new SweetenerContentMapper().initialize({
        protocolVersion: 1,
        positionEncodings: ["utf-8", "utf-16"],
      }),
    ).toEqual({
      protocolVersion: 1,
      positionEncoding: "utf-16",
      diagnosticSource: "SWR",
    });
    expect(
      new SweetenerContentMapper().initialize({ positionEncodings: ["utf-8"] })
        .positionEncoding,
    ).toBe("utf-8");
  });

  test("refuses a protocol version it does not speak", () => {
    expect(() =>
      new SweetenerContentMapper().initialize({
        protocolVersion: 2,
        positionEncodings: ["utf-16"],
      }),
    ).toThrow(/speaks content-mapper protocol 1/u);
  });

  test("refuses to work before it is initialized", () => {
    expect(() =>
      new SweetenerContentMapper().openProject({
        configFileName: "",
        projectHandle: "p",
        compilerOptions: {},
      }),
    ).toThrow(ResponseError);
  });
});

describe("openProject", () => {
  test("watches what an expansion read from another file, and digests it", () => {
    const { config, file } = project();
    const { result } = opened(config);
    // A file's own text is not among them: TypeScript transforms a file again
    // when that changes, without the project's identity changing.
    expect(result.watchedFiles).toEqual([config, file("macros.sts")].sort());
    expect(result.configIdentity).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.optionDiagnostics).toEqual([]);
  });

  test("keeps TypeScript's unsaved text when the config changes", () => {
    const { config, file } = project();
    const { mapper, transform } = opened(config);
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          strict: true,
          noUnusedLocals: true,
        },
        contentMappers: [
          { package: "@sweetener/content-mapper", extensions: [".sts"] },
        ],
        include: ["*.sts"],
      }),
    );
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ", 1)`);
  });

  test("keeps TypeScript's unsaved text while the config cannot be used", () => {
    const { config, file } = project();
    const { mapper, transform } = opened(config);
    const reopen = () =>
      mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      });
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    const usable = readFileSync(config, "utf8");
    writeFileSync(config, "{ not json");
    expect(reopen().optionDiagnostics).toHaveLength(1);
    // Sent while the config is broken, and just as much what the file says.
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 2)"),
    );
    writeFileSync(config, usable);
    expect(reopen().optionDiagnostics).toEqual([]);
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ", 2)`);
  });

  test("an unsaved change to a macro module changes the identity, and one to a file that only uses it does not", () => {
    const { config, file } = project();
    const { mapper, result, transform } = opened(config);
    const reopen = () =>
      mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      }).configIdentity;
    expect(reopen()).toBe(result.configIdentity);
    transform(file("main.sts"), `${main}\n// typed\n`);
    expect(reopen()).toBe(result.configIdentity);
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    const changed = reopen();
    expect(changed).not.toBe(result.configIdentity);
    // The edit undone, the project is what it was.
    transform(file("macros.sts"), macros);
    expect(reopen()).toBe(result.configIdentity);
  });

  test("a saved change to a macro module changes the identity", () => {
    const { config, file } = project();
    const before = opened(config).result.configIdentity;
    writeFileSync(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    expect(opened(config).result.configIdentity).not.toBe(before);
  });

  test("takes options of null as none given", () => {
    const { config } = project();
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    const result = mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      options: null,
      compilerOptions: {},
    });
    expect(result.optionDiagnostics).toEqual([]);
  });

  test("refuses options, which belong in the tsconfig's sweet section", () => {
    const { config } = project();
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    const result: OpenProjectResult = mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      options: { strict: true },
      compilerOptions: {},
    });
    expect(result.optionDiagnostics).toEqual([
      expect.objectContaining({ path: [], code: 6001 }),
    ]);
  });
});

describe("transform", () => {
  test("returns the expansion, mapped so TypeScript accepts it", () => {
    const { config, file } = project();
    const result = opened(config).transform(file("main.sts"));
    expect(result.extension).toBe(".ts");
    expect(result.text).toContain(`export const result = trim("  hello  ");`);
    expect(result.diagnostics).toEqual([]);
    expectAcceptable(result, main);
  });

  test("maps the author's tokens verbatim and the macro's own text to its invocation", () => {
    const { config, file } = project();
    const result = opened(config).transform(file("main.sts"));
    const at = (virtual: string) => {
      const start = result.text.indexOf(virtual);
      return result.mappings.find(([virtualStart]) => virtualStart === start);
    };
    const literal = `"  hello  "`;
    expect(at(literal)).toEqual([
      result.text.indexOf(literal),
      literal.length,
      main.indexOf(literal),
      literal.length,
      SpanMapKind.Verbatim,
    ]);
    // The parenthesis the template wrote exists nowhere in the source; it
    // carries diagnostics to the invocation and nothing else.
    const paren = result.text.indexOf(`("  hello  ")`);
    const introduced = result.mappings.find(([start]) => start === paren);
    expect(introduced?.[4]).toBe(SpanMapKind.Atom);
    expect(introduced?.[5]).toBe(SpanMapFeature.None);
  });

  test("a name copied twice to one binding stays renamable", () => {
    const pair = `import { twice } from "./twice.sts" for syntax;\nconst value = 21;\nexport const both = twice(value);\n`;
    const { config, file } = project({
      "twice.sts": `export syntax twice:expr { rule { twice($value:expr) } => { [$value, $value] } }\n`,
      "pair.sts": pair,
    });
    const result = opened(config).transform(file("pair.sts"));
    const use = pair.lastIndexOf("value");
    const copies = result.mappings.filter(
      ([, , originalStart]) => originalStart === use,
    );
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy[4]).toBe(SpanMapKind.Verbatim);
      expect(copy[5]).toBeUndefined();
    }
  });

  test("copies of a name bound to different things cannot be renamed", () => {
    // The captured `x` both refers to the outer `x` and declares the
    // parameter `x + 1` reads. Renaming either binding through the one token
    // would change what the other means.
    const main = `import { shadow } from "./shadow.sts" for syntax;\nconst x = 5;\nexport const r = shadow(x, x + 1);\n`;
    const { config, file } = project({
      "shadow.sts": `export syntax shadow:expr { rule { shadow($x:ident, $body:expr) } => { [$x, (($x) => $body)(0)] } }\n`,
      "shadowed.sts": main,
    });
    const result = opened(config).transform(file("shadowed.sts"));
    expect(result.text).toContain("[x, ((x) => x + 1)(0)]");
    const captured = main.indexOf("x", main.indexOf("shadow("));
    const copies = result.mappings.filter(
      ([, , originalStart]) => originalStart === captured,
    );
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy[4]).toBe(SpanMapKind.Atom);
      expect(copy[5]! & SpanMapFeature.Rename).toBe(0);
      expect(copy[5]! & SpanMapFeature.LinkedEditing).toBe(0);
    }
    // The body's `x` was written once and names one binding.
    const body = result.mappings.find(
      ([, , originalStart]) => originalStart === main.indexOf("x + 1"),
    );
    expect(body?.[4]).toBe(SpanMapKind.Verbatim);
    expectAcceptable(result, main);
  });

  test("a macro module expands to what it leaves at runtime", () => {
    const { config, file } = project();
    const result = opened(config).transform(file("macros.sts"));
    expect(result.text.trim()).toBe("");
    expectAcceptable(result, macros);
  });

  test("expands the text TypeScript sent, not the file on disk", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    const unsaved = main.replace(`"  hello  " |> trim`, `"  bye  " |> trim`);
    const result = transform(file("main.sts"), unsaved);
    expect(result.text).toContain(`trim("  bye  ")`);
    expectAcceptable(result, unsaved);
    // And back again once the buffer matches the file.
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ")`);
  });

  test("unsaved macro text reaches a file that uses it", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, $value)"),
    );
    expect(transform(file("main.sts")).text).toContain(
      `trim("  hello  ", "  hello  ")`,
    );
  });

  test("a saved file wins over older unsaved text TypeScript sent for it", () => {
    const { config, file } = project();
    const { transform, mapper } = opened(config);
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, $value)"),
    );
    // Saved, differently. TypeScript reopens the project and may ask for the
    // file that uses the macro before it re-sends the macro module itself.
    writeFileSync(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 0)"),
    );
    mapper.closeProject({ projectHandle: "p" });
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ", 0)`);
  });

  test("a project reopened unchanged keeps what it expanded", () => {
    const { config, file } = project();
    const { transform, mapper } = opened(config);
    const before = transform(file("main.sts"));
    mapper.closeProject({ projectHandle: "p" });
    const reopened = mapper.openProject({
      configFileName: config,
      projectHandle: "q",
      compilerOptions: {},
    });
    expect(reopened.watchedFiles).toContain(file("macros.sts"));
    const after = mapper.transform({
      fileName: file("main.sts"),
      content: main,
      projectHandle: "q",
    });
    expect(after).toEqual(before);
  });

  test("reports expansion errors at their place in the source", () => {
    const broken = `import { (|>) } from "./macros.sts" for syntax;\nexport const bad = 5 |> ;\n`;
    const { config, file } = project({ "broken.sts": broken });
    const result = opened(config).transform(file("broken.sts"));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ start: broken.lastIndexOf("|>"), code: 4021 }),
    ]);
    expectAcceptable(result, broken);
  });

  test("encodes offsets as UTF-8 bytes when that is what TypeScript takes", () => {
    const text = main.replace(`"  hello  "`, `"  héllo 🍬 "`);
    const { config, file } = project({ "main.sts": text });
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-8"] });
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });
    const result = mapper.transform({
      fileName: file("main.sts"),
      content: text,
      projectHandle: "p",
    });
    const semicolon = result.mappings.at(-1)!;
    expect(semicolon[2]).toBe(
      Buffer.byteLength(text.slice(0, text.lastIndexOf(";"))),
    );
    expect(semicolon[4]).toBe(SpanMapKind.Verbatim);
  });

  test("names the config when a file is not part of the project", () => {
    const { config, directory } = project();
    const outside = join(directory, "outside.sts");
    writeFileSync(outside, "export const x = 1;\n");
    writeFileSync(
      config,
      JSON.stringify({ files: ["macros.sts", "main.sts"] }),
    );
    expect(opened(config).transform(outside)).toEqual({
      text: "",
      extension: ".ts",
      mappings: [],
      diagnostics: [
        {
          messageText: expect.stringContaining(
            `not opted into Sweetener expansion by ${config}`,
          ),
          start: 0,
          length: 0,
          code: 6202,
        },
      ],
    });
  });

  test("names macroExtensions when it leaves out the extension being mapped", () => {
    const { config, file } = project({ "plain.ts": "export {};\n" });
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(readFileSync(config, "utf8")),
        include: ["*.sts", "*.ts"],
        sweet: { macroExtensions: [".stsx"] },
      }),
    );
    expect(opened(config).transform(file("main.sts")).diagnostics).toEqual([
      expect.objectContaining({
        code: 6202,
        messageText: expect.stringContaining(
          "`sweet.macroExtensions` does not list .sts",
        ),
      }),
    ]);
  });

  test("says what is wrong with a config it cannot use, and recovers once fixed", () => {
    const { config, file } = project();
    const valid = readFileSync(config, "utf8");
    writeFileSync(
      config,
      JSON.stringify({ ...JSON.parse(valid), sweet: { bogus: true } }),
    );
    const { result, transform, mapper } = opened(config);
    expect(result.optionDiagnostics).toEqual([
      {
        path: [],
        code: 6001,
        messageText: expect.stringMatching(
          /Sweetener cannot use .*sweet\.bogus is not a recognized option/u,
        ),
      },
    ]);
    expect(transform(file("main.sts")).diagnostics).toEqual([
      expect.objectContaining({ code: 6001, start: 0 }),
    ]);
    writeFileSync(config, valid);
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ")`);
  });

  test("refuses an unknown project handle", () => {
    const { config, file } = project();
    const { mapper } = opened(config);
    expect(() =>
      mapper.transform({
        fileName: file("main.sts"),
        content: main,
        projectHandle: "q",
      }),
    ).toThrow(/Unknown project handle/u);
    mapper.closeProject({ projectHandle: "p" });
    expect(() =>
      mapper.transform({
        fileName: file("main.sts"),
        content: main,
        projectHandle: "p",
      }),
    ).toThrow(/Unknown project handle/u);
  });
});

describe("a config that finds no inputs", () => {
  test("is no problem of its, and a file made under it expands", () => {
    const { directory, config } = project();
    mkdirSync(join(directory, "src"));
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["src"],
      }),
    );
    const { result, transform } = opened(config);
    expect(result.optionDiagnostics).toEqual([]);
    const made = join(directory, "src", "a.sts");
    writeFileSync(made, "export const a = 1;\n");
    const answer = transform(made);
    expect(answer.diagnostics).toEqual([]);
    expect(answer.text).toContain("export const a = 1;");
  });
});

describe("a config it cannot use", () => {
  test("hears a change to a config the broken one extends, and watches it", () => {
    const { config, directory } = project();
    const base = join(directory, "base.json");
    writeFileSync(
      config,
      JSON.stringify({ extends: "./base", include: ["*.sts"] }),
    );
    writeFileSync(base, "{ not json");
    const { result: before } = opened(config);
    expect(before.optionDiagnostics).toHaveLength(1);
    expect(before.watchedFiles).toEqual(expect.arrayContaining([base, config]));
    writeFileSync(base, "{ still not");
    expect(opened(config).result.configIdentity).not.toBe(
      before.configIdentity,
    );
  });

  test("leaves an option TypeScript 6 does not know to the TypeScript running", () => {
    const { config, file } = project();
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", checkers: 2 },
        include: ["*.sts"],
      }),
    );
    const { result, transform } = opened(config);
    expect(result.optionDiagnostics).toEqual([]);
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ")`);
  });
});

describe("a project with no tsconfig", () => {
  test("is refused, saying what it needs", () => {
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    expect(() =>
      mapper.openProject({
        configFileName: "",
        projectHandle: "p",
        compilerOptions: {},
      }),
    ).toThrow(/only as part of a project/u);
  });
});

describe("a macro module it may not look at", () => {
  test("opens the project all the same", () => {
    const { config, directory, file } = project({
      "main.sts":
        'import { one } from "./lib/macros.sts" for syntax;\nexport const a = one;\n',
    });
    const lib = join(directory, "lib");
    mkdirSync(lib);
    writeFileSync(
      join(lib, "macros.sts"),
      "export syntax one:expr { rule { one } => { 1 } }\n",
    );
    const { mapper, transform } = opened(config);
    expect(transform(file("main.sts")).text).toContain("export const a = 1;");
    chmodSync(lib, 0o000);
    try {
      const reopened = mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      });
      expect(reopened.configIdentity).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      chmodSync(lib, 0o755);
    }
  });
});

describe("dependencies", () => {
  test("watches what a saved macro module newly imports, at the open that finds it", () => {
    const { config, directory, file } = project();
    const { mapper, result } = opened(config);
    const helper = join(directory, "helper.sts");
    writeFileSync(helper, "export syntax one:expr { rule { one } => { 1 } }\n");
    writeFileSync(
      file("macros.sts"),
      `import { one } from "./helper.sts" for syntax;\n${macros}`,
    );
    const open = () =>
      mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      });
    const saved = open();
    expect(saved.watchedFiles).toContain(helper);
    expect(saved.configIdentity).not.toBe(result.configIdentity);
    // Nothing changed since: TypeScript has no reason to transform it all again.
    expect(open().configIdentity).toBe(saved.configIdentity);
  });

  const literals = {
    "local.ts": "export const Circle = 1;\n",
    "macros.sts": [
      'import { Circle } from "./local";',
      "export syntax kind:expr {",
      "  literal Circle as Circle;",
      '  rule { kind(Circle) } => { "circle" }',
      '  fallback rule { kind($value:expr) } => { "other" }',
      "}",
      "",
    ].join("\n"),
    "main.sts":
      'import { kind } from "./macros.sts" for syntax;\nimport { Circle } from "./local";\nexport const answer = kind(Circle);\n',
  };

  test("watches every source where binding literals read them all", () => {
    const { config, file } = project(literals);
    const { result } = opened(config);
    expect(result.watchedFiles).toEqual(
      expect.arrayContaining([file("main.sts"), file("local.ts")]),
    );
  });
});

describe("a compiler failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Has expansion throw wherever it is asked to expand `culprit`, past reading
   * the project, as a failure printing it would.
   */
  function failingOn(culprit: string) {
    const expand = DefaultProjectExpansionProvider.prototype.expandProject;
    return vi
      .spyOn(DefaultProjectExpansionProvider.prototype, "expandProject")
      .mockImplementation(function (
        this: DefaultProjectExpansionProvider,
        project,
        options,
      ) {
        if (options?.files === undefined || options.files.has(culprit)) {
          expand.call(this, project, options);
          throw new Error("the compiler broke");
        }
        return expand.call(this, project, options);
      });
  }

  test("is the file's that caused it, and the others expand", () => {
    const { config, file } = project({ "other.sts": "export const o = 1;\n" });
    const failing = failingOn(file("other.sts"));
    const { result, transform } = opened(config);
    expect(result.optionDiagnostics).toEqual([]);
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ")`);
    const attempts = failing.mock.calls.length;
    expect(transform(file("other.sts")).diagnostics).toEqual([
      expect.objectContaining({
        code: 6201,
        messageText: "Project expansion failed: the compiler broke",
      }),
    ]);
    // Once for the file: what it read is known without reading the project again.
    expect(failing.mock.calls).toHaveLength(attempts + 1);
    // Fixed by what TypeScript sends next, with no reopen to carry it.
    failing.mockRestore();
    const fixed = transform(file("other.sts"), "export const o = 2;\n");
    expect(fixed.diagnostics).toEqual([]);
    expect(fixed.text).toContain("export const o = 2;");
  });

  test("a file that goes on failing costs the others nothing", () => {
    const { config, file } = project({ "other.sts": "export const o = 1;\n" });
    const failing = failingOn(file("other.sts"));
    const { mapper, transform } = opened(config);
    expect(transform(file("main.sts")).diagnostics).toEqual([]);
    transform(file("other.sts"));
    writeFileSync(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });
    // What the open expanded stands: it was not lost with the file that failed.
    const expansions = failing.mock.calls.length;
    const used = transform(file("main.sts"));
    expect(failing.mock.calls).toHaveLength(expansions);
    expect(used.diagnostics).toEqual([]);
    expect(used.text).toContain(`trim("  hello  ", 1)`);
  });

  test("does not read every source again for each file once that has failed", () => {
    const { config, file } = project({ "other.sts": "export const o = 1;\n" });
    const expand = DefaultProjectExpansionProvider.prototype.expandProject;
    const whole: unknown[] = [];
    vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    ).mockImplementation(function (
      this: DefaultProjectExpansionProvider,
      project,
      options,
    ) {
      if (options?.onlyNarrowly !== true) {
        whole.push(options?.files);
        expand.call(this, project, options);
        throw new Error("the compiler broke");
      }
      return expand.call(this, project, options);
    });
    vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "failedReadingEverySource",
    ).mockReturnValue(true);
    const { transform } = opened(config);
    // All together, then one alone, for the rest to need no more than they lead to.
    expect(whole).toHaveLength(2);
    expect(transform(file("main.sts")).diagnostics).toEqual([]);
    expect(transform(file("other.sts")).diagnostics).toEqual([]);
  });

  test("a fix to anything the project lists reaches a file that failed", () => {
    const { config, file } = project({ "other.sts": "export const o = 1;\n" });
    const failing = failingOn(file("other.sts"));
    const { mapper, transform } = opened(config);
    const open = () =>
      mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      });
    transform(file("main.sts"));
    transform(file("other.sts"));
    const failed = open();
    expect(failed.watchedFiles).toContain(file("main.sts"));
    // A file nothing else reads, which nothing else would count.
    writeFileSync(file("main.sts"), `${main}// fixed\n`);
    const changed = open();
    expect(changed.configIdentity).not.toBe(failed.configIdentity);
    // Mended, the project is back to what its expansions read.
    failing.mockRestore();
    transform(file("other.sts"));
    const mended = open();
    expect(mended.watchedFiles).not.toContain(file("other.sts"));
    expect(mended.configIdentity).not.toBe(changed.configIdentity);
  });

  test("a fix to a macro module the project does not list reaches a file that failed", () => {
    const { config, directory, file } = project({
      "a.sts":
        'import { one } from "./sub/macros.sts" for syntax;\nexport const a = one;\n',
    });
    const module = join(directory, "sub", "macros.sts");
    mkdirSync(dirname(module));
    writeFileSync(module, "export syntax one:expr { rule { one } => { 1 } }\n");
    failingOn(file("a.sts"));
    const { mapper } = opened(config);
    const open = () =>
      mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      });
    const failed = open();
    expect(failed.watchedFiles).toContain(module);
    writeFileSync(module, "export syntax one:expr { rule { one } => { 2 } }\n");
    expect(open().configIdentity).not.toBe(failed.configIdentity);
  });

  test("what each failed file read counts, whichever failed last", () => {
    const { config, directory, file } = project({
      "other.sts": "export {};\n",
    });
    const inputs = (name: string) => [
      { kind: "file" as const, path: join(directory, name), text: undefined },
    ];
    const read = vi
      .spyOn(DefaultProjectExpansionProvider.prototype, "readInputs")
      .mockReturnValueOnce(inputs("first-read.sts"))
      .mockReturnValueOnce(inputs("second-read.sts"));
    const failing = vi
      .spyOn(DefaultProjectExpansionProvider.prototype, "expandProject")
      .mockImplementation(() => {
        throw new Error("the compiler broke");
      });
    const { mapper, transform } = opened(config);
    transform(file("other.sts"));
    const { watchedFiles } = mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });
    expect(watchedFiles).toEqual(
      expect.arrayContaining([
        join(directory, "first-read.sts"),
        join(directory, "second-read.sts"),
      ]),
    );
    failing.mockRestore();
    read.mockRestore();
  });

  test("a failure every file meets is said by each, and over once text changes", () => {
    const { config, file } = project();
    const failing = vi
      .spyOn(DefaultProjectExpansionProvider.prototype, "expandProject")
      .mockImplementation(() => {
        throw new Error("reading broke");
      });
    const { transform } = opened(config);
    for (const name of ["main.sts", "macros.sts"])
      expect(transform(file(name)).diagnostics).toEqual([
        expect.objectContaining({
          code: 6201,
          messageText: "Project expansion failed: reading broke",
        }),
      ]);
    failing.mockRestore();
    expect(transform(file("main.sts"), `${main}\n`).diagnostics).toEqual([]);
  });
});

describe("what it lets go of", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const open = (
    mapper: SweetenerContentMapper,
    config: string,
    handle: string,
  ) =>
    mapper.openProject({
      configFileName: config,
      projectHandle: handle,
      compilerOptions: {},
    });

  test("keeps the configs opened last, and not the ones before", () => {
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    const configs = Array.from({ length: 10 }, () => project().config);
    for (const config of configs) {
      open(mapper, config, "p");
      mapper.closeProject({ projectHandle: "p" });
    }
    const expand = vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    );
    open(mapper, configs.at(-1)!, "last");
    expect(expand).not.toHaveBeenCalled();
    open(mapper, configs[0]!, "first");
    expect(expand).toHaveBeenCalledOnce();
  });

  test("keeps a config with a project open however long ago it opened", () => {
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    const [first, ...rest] = Array.from({ length: 10 }, () => project().config);
    open(mapper, first!, "held");
    for (const config of rest) {
      open(mapper, config, "p");
      mapper.closeProject({ projectHandle: "p" });
    }
    const expand = vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    );
    open(mapper, first!, "held");
    expect(expand).not.toHaveBeenCalled();
  });

  test("text held for a file that changed does not come back with the file", () => {
    const { config, file } = project();
    const { mapper, transform } = opened(config);
    transform(
      file("macros.sts"),
      macros.replace("$callee($value)", "$callee($value, 1)"),
    );
    writeFileSync(file("macros.sts"), `${macros}// changed\n`);
    open(mapper, config, "p");
    writeFileSync(file("macros.sts"), macros);
    open(mapper, config, "p");
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ")`);
  });

  test("lets go of configs by when they were opened, whichever could be used", () => {
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    for (let older = 0; older < 8; older += 1) {
      open(mapper, project().config, "other");
      mapper.closeProject({ projectHandle: "other" });
    }
    const recent = project();
    const usable = readFileSync(recent.config, "utf8");
    open(mapper, recent.config, "p");
    mapper.transform({
      fileName: recent.file("macros.sts"),
      content: macros.replace("$callee($value)", "$callee($value, 1)"),
      projectHandle: "p",
    });
    writeFileSync(recent.config, "{ not json");
    open(mapper, recent.config, "p");
    mapper.closeProject({ projectHandle: "p" });
    open(mapper, project().config, "last");
    writeFileSync(recent.config, usable);
    open(mapper, recent.config, "p");
    expect(
      mapper.transform({
        fileName: recent.file("main.sts"),
        content: main,
        projectHandle: "p",
      }).text,
    ).toContain(`trim("  hello  ", 1)`);
  });

  test("forgets a config whose file is gone", () => {
    const { config, file } = project();
    const usable = readFileSync(config, "utf8");
    const { mapper } = opened(config);
    mapper.closeProject({ projectHandle: "p" });
    rmSync(config);
    open(mapper, project().config, "other");
    const expand = vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    );
    writeFileSync(config, usable);
    open(mapper, config, "p");
    expect(expand).toHaveBeenCalled();
    expect(file("main.sts")).toBeDefined();
  });
});

describe("what it does not expand again", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The files each expansion from here on is asked for, `all` for every one. */
  const expansions = () => {
    const spy = vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    );
    return () =>
      spy.mock.calls.map(([, options]) =>
        options?.files === undefined ? "all" : [...options.files].sort(),
      );
  };
  const reopen = (mapper: SweetenerContentMapper, config: string) =>
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });

  test("a file the project does not list says so without reading the project", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    const asked = expansions();
    const result = transform(file("elsewhere.stsx"), "export const a = 1;\n");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 6202 }),
    ]);
    expect(result.extension).toBe(".tsx");
    expect(asked()).toEqual([]);
  });

  test("a file found as soon as it is asked for changes nothing else", () => {
    const { config, file } = project();
    const { mapper, result, transform } = opened(config);
    writeFileSync(file("added.sts"), "export const a = 1;\n");
    transform(file("added.sts"));
    expect(reopen(mapper, config).configIdentity).toBe(result.configIdentity);
  });

  test("typing in a file with a binding literal elsewhere expands that file", () => {
    const { config, file } = project({
      "local.ts": "export const Circle = 1;\n",
      "macros.sts": [
        'import { Circle } from "./local";',
        "export syntax kind:expr {",
        "  literal Circle as Circle;",
        '  rule { kind(Circle) } => { "circle" }',
        '  fallback rule { kind($value:expr) } => { "other" }',
        "}",
        "",
      ].join("\n"),
      "main.sts":
        'import { kind } from "./macros.sts" for syntax;\nimport { Circle } from "./local";\nexport const a = kind(Circle);\n',
      "other.sts": "export const o = 1;\n",
    });
    const { transform } = opened(config);
    const asked = expansions();
    transform(file("other.sts"), "export const o = 2;\n");
    expect(asked()).toEqual([[file("other.sts")]]);
  });

  test("a binding literal gone stops the config being loaded at every open", () => {
    const module = (literal: boolean) =>
      [
        'import { Circle } from "./local";',
        "export syntax kind:expr {",
        ...(literal ? ["  literal Circle as Circle;"] : []),
        '  rule { kind(Circle) } => { "circle" }',
        '  fallback rule { kind($value:expr) } => { "other" }',
        "}",
        "",
      ].join("\n");
    const { config, file } = project({
      "local.ts": "export const Circle = 1;\n",
      "macros.sts": module(true),
      "main.sts":
        'import { kind } from "./macros.sts" for syntax;\nexport const a = kind(1);\n',
    });
    const { mapper } = opened(config);
    writeFileSync(file("macros.sts"), module(false));
    reopen(mapper, config);
    const walked = vi.spyOn(ts.sys, "readDirectory");
    reopen(mapper, config);
    expect(walked).not.toHaveBeenCalled();
  });

  test("a file made expands when it is asked for, and keeps what the others expanded to", () => {
    const { config, file } = project();
    const { mapper, transform } = opened(config);
    const asked = expansions();
    writeFileSync(file("added.sts"), "export const a = 1;\n");
    reopen(mapper, config);
    expect(asked()).toEqual([]);
    expect(transform(file("main.sts")).text).toContain(`trim("  hello  ")`);
    expect(asked()).toEqual([]);
    expect(transform(file("added.sts")).text).toContain("export const a = 1;");
    expect(asked()).toEqual([[file("added.sts")]]);
  });

  test("a file gone is expanded once to find so, and the others stay", () => {
    const { config, directory, file } = project({ "gone.sts": "export {};\n" });
    const { mapper, transform } = opened(config);
    const asked = expansions();
    rmSync(join(directory, "gone.sts"));
    reopen(mapper, config);
    expect(asked()).toEqual([[file("gone.sts")]]);
    transform(file("main.sts"));
    reopen(mapper, config);
    expect(asked()).toHaveLength(1);
  });

  test("a config that changes is loaded again and lists what it now does", () => {
    const { config, file } = project();
    const { mapper, transform } = opened(config);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022", strict: true },
        include: ["main.sts", "macros.sts"],
      }),
    );
    writeFileSync(file("later.sts"), "export const l = 1;\n");
    reopen(mapper, config);
    expect(transform(file("later.sts")).diagnostics).toEqual([
      expect.objectContaining({ code: 6202 }),
    ]);
  });

  test("a file made expands everything where binding literals read the file list", () => {
    const { config, file } = project({
      "local.ts": "export const Circle = 1;\n",
      "macros.sts": [
        'import { Circle } from "./local";',
        "export syntax kind:expr {",
        "  literal Circle as Circle;",
        '  rule { kind(Circle) } => { "circle" }',
        '  fallback rule { kind($value:expr) } => { "other" }',
        "}",
        "",
      ].join("\n"),
      "main.sts":
        'import { kind } from "./macros.sts" for syntax;\nimport { Circle } from "./local";\nexport const answer = kind(Circle);\n',
    });
    const { mapper } = opened(config);
    const asked = expansions();
    writeFileSync(file("added.sts"), "export const a = 1;\n");
    reopen(mapper, config);
    // Every file it could be asked for, which is all a program of them depends on.
    expect(asked()).toEqual([
      [file("added.sts"), file("macros.sts"), file("main.sts")],
    ]);
  });

  test("does not load a config again while it says the same", () => {
    const { config } = project();
    const { mapper } = opened(config);
    const walked = vi.spyOn(ts.sys, "readDirectory");
    reopen(mapper, config);
    expect(walked).not.toHaveBeenCalled();
  });

  test("loads the config again where binding literals read the file list", () => {
    const { config } = project({
      "local.ts": "export const Circle = 1;\n",
      "macros.sts": [
        'import { Circle } from "./local";',
        "export syntax kind:expr {",
        "  literal Circle as Circle;",
        '  rule { kind(Circle) } => { "circle" }',
        '  fallback rule { kind($value:expr) } => { "other" }',
        "}",
        "",
      ].join("\n"),
    });
    const { mapper } = opened(config);
    const walked = vi.spyOn(ts.sys, "readDirectory");
    reopen(mapper, config);
    expect(walked).toHaveBeenCalled();
  });
});

describe("a file the config does not list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("several are each looked for once", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    const names = ["new1.sts", "new2.sts", "new3.sts"];
    for (const name of names) writeFileSync(file(name), "export {};\n");
    const walked = vi.spyOn(ts.sys, "readDirectory");
    for (const name of names) transform(file(name), "export {};\n");
    const walks = walked.mock.calls.length;
    for (const name of names) transform(file(name), "export {};\n");
    expect(walked.mock.calls).toHaveLength(walks);
  });

  test("in a folder renamed into place is found, its files' times being old", () => {
    const { config, directory, file } = project();
    mkdirSync(join(directory, "src"));
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["src"],
      }),
    );
    writeFileSync(file("src/a.sts"), "export const a = 1;\n");
    mkdirSync(join(directory, "elsewhere"));
    writeFileSync(file("elsewhere/moved.sts"), "export const m = 1;\n");
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { transform } = opened(config);
    renameSync(join(directory, "elsewhere"), join(directory, "src", "moved"));
    now += 3_000;
    const moved = transform(file("src/moved/moved.sts"));
    expect(moved.diagnostics).toEqual([]);
    expect(moved.text).toContain("export const m = 1;");
  });

  test("written before the config was loaded is not looked for", () => {
    const { config, file } = project();
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["macros.sts", "main.sts"],
      }),
    );
    writeFileSync(file("outside.sts"), "export {};\n");
    // Opened long enough after every file was written for its stat to say so.
    const later = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => later);
    const { transform } = opened(config);
    const walked = vi.spyOn(ts.sys, "readDirectory");
    expect(transform(file("outside.sts")).diagnostics).toEqual([
      expect.objectContaining({ code: 6202 }),
    ]);
    expect(walked).not.toHaveBeenCalled();
  });

  test("hears what is wrong with a config that has since broken", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    writeFileSync(config, JSON.stringify({ sweet: { nonsense: 1 } }));
    writeFileSync(file("new.sts"), "export const n = 1;\n");
    expect(transform(file("new.sts")).diagnostics).toEqual([
      expect.objectContaining({
        code: 6001,
        messageText: expect.stringContaining("nonsense"),
      }),
    ]);
  });

  test("changes the identity when it is saved, and is watched", () => {
    const { config, file } = project({ "other.txt": "" });
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts"],
      }),
    );
    const { mapper, transform } = opened(config);
    const text = "export const n = 1;\n";
    transform(file("elsewhere.sts"), text);
    const open = () =>
      mapper.openProject({
        configFileName: config,
        projectHandle: "p",
        compilerOptions: {},
      });
    const before = open();
    expect(before.watchedFiles).toContain(file("elsewhere.sts"));
    expect(open().configIdentity).toBe(before.configIdentity);
    writeFileSync(file("elsewhere.sts"), text);
    expect(open().configIdentity).not.toBe(before.configIdentity);
  });

  test("is looked for once, and again when it is saved", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    const walked = vi.spyOn(ts.sys, "readDirectory");
    const text = "export const n = 1;\n";
    expect(transform(file("new.sts"), text).diagnostics).toEqual([
      expect.objectContaining({ code: 6202 }),
    ]);
    // Not on disk, so walking `include` could not find it.
    expect(walked).not.toHaveBeenCalled();
    transform(file("new.sts"), `${text}// typed\n`);
    expect(walked).not.toHaveBeenCalled();
    const walks = walked.mock.calls.length;
    writeFileSync(file("new.sts"), text);
    expect(transform(file("new.sts"), text).diagnostics).toEqual([]);
    expect(walked.mock.calls.length).toBeGreaterThan(walks);
  });
});

describe("a macro module read as its own macros say", () => {
  test("stays so for a file using it, through every edit", () => {
    const { config, file } = project({
      "base.sts":
        "export syntax stmt:stmt { rule { stmt($v:expr) } => { $v; } }\n",
      "macros.sts": `import { stmt } from "./base.sts" for syntax;
stmt(1) /{/.test("x");
export syntax foo:expr { rule { foo($v:expr) } => { $v } }
`,
      "main.sts":
        'import { foo } from "./macros.sts" for syntax;\nexport const v = foo(1);\n',
    });
    const { transform } = opened(config);
    expect(transform(file("main.sts")).diagnostics).toEqual([]);
    const edited = transform(
      file("main.sts"),
      'import { foo } from "./macros.sts" for syntax;\nexport const v = foo(2);\n',
    );
    expect(edited.diagnostics).toEqual([]);
    expect(edited.text).toContain("export const v = 2;");
  });
});

describe("a name a macro copies to stand for two", () => {
  const rename = SpanMapFeature.Rename;
  /** The features of the mapping of `foo` in a macro's input. */
  function featuresOf(macro: string, use: string) {
    const { config, file } = project({
      "macros.sts": macro,
      "main.sts": `import { m } from "./macros.sts" for syntax;\nconst foo = 1;\n${use}\n`,
    });
    const source = readFileSync(file("main.sts"), "utf8");
    const argument = source.indexOf("foo", source.indexOf("m(foo"));
    const { mappings } = opened(config).transform(file("main.sts"));
    const copy = mappings.find(
      ([, , originalStart]) => originalStart === argument,
    );
    if (copy === undefined) throw new Error("the argument has no mapping");
    return copy[5] ?? SpanMapFeature.All;
  }

  test.each([
    ["a shorthand property", "({ $x })", "export const o = m(foo);"],
    [
      "a destructuring pattern",
      "(() => { const { $x } = { foo: 1 }; return $x; })()",
      "export const o = m(foo);",
    ],
  ])("refuses rename once, in %s", (_, template, use) => {
    const features = featuresOf(
      `export syntax m:expr { rule { m($x:ident) } => { ${template} } }\n`,
      use,
    );
    expect(features & rename).toBe(0);
  });

  test("refuses rename in an export specifier", () => {
    const features = featuresOf(
      "export syntax m:item { rule { m($x:ident); } => { export { $x }; } }\n",
      "m(foo);",
    );
    expect(features & rename).toBe(0);
  });

  test("refuses rename from every copy, the one it could reach included", () => {
    const { config, file } = project({
      "macros.sts":
        "export syntax m:expr { rule { m($x:ident) } => { (() => { const { $x } = { foo: 1 }; return $x; })() } }\n",
      "main.sts":
        'import { m } from "./macros.sts" for syntax;\nconst foo = 1;\nexport const o = m(foo);\n',
    });
    const source = readFileSync(file("main.sts"), "utf8");
    const argument = source.indexOf("foo", source.indexOf("m(foo"));
    const copies = opened(config)
      .transform(file("main.sts"))
      .mappings.filter(([, , originalStart]) => originalStart === argument);
    expect(copies).toHaveLength(2);
    for (const copy of copies)
      expect((copy[5] ?? SpanMapFeature.All) & rename).toBe(0);
  });

  test("keeps rename for a plain copy, and for a shorthand the author wrote", () => {
    expect(
      featuresOf(
        "export syntax m:expr { rule { m($x:ident) } => { [$x] } }\n",
        "export const o = m(foo);",
      ) & rename,
    ).toBe(rename);
    const { config, file } = project({
      "main.sts": "const foo = 1;\nexport const o = { foo };\n",
    });
    const { mappings } = opened(config).transform(file("main.sts"));
    expect(mappings.every((mapping) => mapping[5] === undefined)).toBe(true);
  });
});

describe("text a macro copied", () => {
  const macro = (name: string, template: string) =>
    `export syntax ${name}:expr { rule { ${name}($v:expr) } => { ${template} } }\n`;
  /** The mappings of what the macro took as its input, not of its template. */
  function copiesOf(macros: string, use: string) {
    const { config, file } = project({
      "macros.sts": macros,
      "main.sts": `import { t } from "./macros.sts" for syntax;\nconst x = 1;\nexport const o = ${use};\n`,
    });
    return opened(config)
      .transform(file("main.sts"))
      .mappings.filter(
        (mapping) => (mapping[5] ?? SpanMapFeature.All) !== SpanMapFeature.None,
      );
  }

  test("more than once takes no exact edit, unless a name", () => {
    const atoms = copiesOf(macro("t", "[$v, $v]"), "t(x+1)").filter(
      ([, , , , kind]) => kind === SpanMapKind.Atom,
    );
    // `+` and `1`, twice each: `x` stays verbatim, for rename to go through.
    expect(atoms).toHaveLength(4);
  });

  test("once is text like any other", () => {
    const { config, file } = project({
      "macros.sts": macro("t", "$v"),
      "main.sts":
        'import { t } from "./macros.sts" for syntax;\nconst x = 1;\nexport const o = t(x+1);\n',
    });
    const copied = opened(config)
      .transform(file("main.sts"))
      .mappings.filter(([, virtualLength]) => virtualLength === 3);
    expect(copied.map(([, , , , kind]) => kind)).toEqual([
      SpanMapKind.Verbatim,
    ]);
  });
});

describe("a token next to another copy of a token", () => {
  test("keeps its own mapping", () => {
    const { config, file } = project({
      "macros.sts":
        "export syntax m:expr { rule { m($a:ident $dot:tt $b:ident) } => { [$a, $a $dot $b] } }\n",
      "main.sts":
        'import { m } from "./macros.sts" for syntax;\nconst a = { b: 1 };\nexport const o = m(a.b);\n',
    });
    const source = readFileSync(file("main.sts"), "utf8");
    const b = source.indexOf("b", source.indexOf("m(a.b"));
    const result = opened(config).transform(file("main.sts"));
    expect(result.diagnostics).toEqual([]);
    expect(
      result.mappings.some(
        ([, , start, length]) => start <= b && b < start + length,
      ),
    ).toBe(true);
  });
});

describe("text the author wrote", () => {
  test("is one mapping where nothing between it differs", () => {
    const { config, file } = project({
      "main.sts": "export const a = 1;\nexport const b = a + 1;\n",
    });
    const { mappings } = opened(config).transform(file("main.sts"));
    expect(mappings).toHaveLength(1);
  });
});

describe("a private name a macro copies", () => {
  test("into two classes refuses rename", () => {
    const { config, file } = project({
      "macros.sts":
        "export syntax two:item { rule { two($n:tt) } => { class A { $n = 1; } class B { $n = 2; } } }\n",
      "main.sts": 'import { two } from "./macros.sts" for syntax;\ntwo(#x);\n',
    });
    const { transform } = opened(config);
    const result = transform(file("main.sts"));
    const copies = result.mappings.filter(
      ([, virtualLength]) => virtualLength === 2,
    );
    expect(copies).toHaveLength(2);
    for (const [, , , , kind] of copies) expect(kind).toBe(SpanMapKind.Atom);
  });
});

describe("a file half typed", () => {
  test("keeps its text and its mappings, for the parser to go on past", () => {
    const { config, file } = project();
    const typing = `${main}export const half = trim(;\n`;
    const answer = opened(config).transform(file("main.sts"), typing);
    expect(answer.text).toContain(`trim("  hello  ")`);
    expect(answer.mappings.length).toBeGreaterThan(0);
  });
});

describe("JSX text that reads like a comment", () => {
  test("is its own text, and takes no time to tell", () => {
    const text = `${"/".repeat(80)}\ntext`;
    const { config, file } = project({
      "main.sts": "",
      "view.stsx": `export const v = <b>${text}</b>;\n`,
    });
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          jsx: "preserve",
        },
        include: ["*.stsx"],
      }),
    );
    const started = performance.now();
    const answer = opened(config).transform(file("view.stsx"));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(answer.text).toContain(text);
    const start = answer.text.indexOf(text);
    expect(
      answer.mappings.some(
        ([virtual, length]) => virtual <= start && start < virtual + length,
      ),
    ).toBe(true);
  });
});

describe("a comment in front of a token", () => {
  test("maps to itself, and leaves the token its own", () => {
    const { config, file } = project({
      "main.sts": "export const a = 1;\n// a comment\nexport const w = 1;\n",
    });
    const { mappings } = opened(config).transform(file("main.sts"));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.[4]).toBe(SpanMapKind.Verbatim);
  });
});

describe("a file with a macro among several", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a project sharing one list of inputs checks it once a run", () => {
    const { config, file } = project({
      "local.ts": "export const Circle = 1;\n",
      "macros.sts": [
        'import { Circle } from "./local";',
        "export syntax kind:expr {",
        "  literal Circle as Circle;",
        '  rule { kind(Circle) } => { "circle" }',
        '  fallback rule { kind($value:expr) } => { "other" }',
        "}",
        "",
      ].join("\n"),
      "a.sts":
        'import { kind } from "./macros.sts" for syntax;\nexport const a = kind(1);\n',
      "b.sts":
        'import { kind } from "./macros.sts" for syntax;\nexport const b = kind(1);\n',
    });
    const { transform } = opened(config);
    const hold = vi.spyOn(InputCheckRound.prototype, "hold");
    const rounds = new Set<unknown>();
    hold.mockImplementation(function (this: InputCheckRound) {
      rounds.add(this);
      return true;
    });
    for (const name of ["a.sts", "b.sts", "macros.sts"]) transform(file(name));
    expect(rounds.size).toBe(1);
  });
});

describe("a file whose own macros could not run", () => {
  test.each([
    [
      "one it defines has errors",
      "export operator (|>):expr { fixity infix; associativity left; precedence 40; rule { $value:nosuch |> $f:ident } => { $f($value) } }\nconst f = (n: number) => n;\nexport const x = 1 |> f;\n",
    ],
    [
      "the module it imports them from is not there",
      'import { (|>) } from "./nope.sts" for syntax;\nconst f = (n: number) => n;\nexport const x = 1 |> f;\n',
    ],
  ])("comes back empty where %s", (_, source) => {
    const { config, file } = project({ "a.sts": source });
    const answer = opened(config).transform(file("a.sts"));
    expect(answer.text).toBe("");
    expect(answer.diagnostics?.length).toBeGreaterThan(0);
  });
});

describe("unsaved text", () => {
  test("is the file's, for every project that reads it", () => {
    const shared = project({
      "macros.sts": "export syntax one:expr { rule { one } => { 1 } }\n",
    });
    const other = project();
    const use = `import { one } from "${relative(other.directory, shared.file("macros.sts"))}" for syntax;\nexport const x = one;\n`;
    writeFileSync(other.file("use.sts"), use);
    writeFileSync(
      other.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["use.sts"],
      }),
    );
    const mapper = new SweetenerContentMapper();
    mapper.initialize({ positionEncodings: ["utf-16"] });
    const open = (config: string, handle: string) =>
      mapper.openProject({
        configFileName: config,
        projectHandle: handle,
        compilerOptions: {},
      });
    open(shared.config, "a");
    open(other.config, "b");
    mapper.transform({
      fileName: shared.file("macros.sts"),
      content: "export syntax one:expr { rule { one } => { 2 } }\n",
      projectHandle: "a",
    });
    expect(
      mapper.transform({
        fileName: other.file("use.sts"),
        content: use,
        projectHandle: "b",
      }).text,
    ).toContain("export const x = 2;");
  });
});

describe("a macro module with errors", () => {
  test("says each once, itself and in a file using it", () => {
    const { config, file } = project({
      "macros.sts": "export syntax twice {\n",
      "main.sts":
        'import { twice } from "./macros.sts" for syntax;\nexport const t = 1;\n',
    });
    const { transform } = opened(config);
    for (const name of ["macros.sts", "main.sts"]) {
      const messages = (transform(file(name)).diagnostics ?? []).map(
        ({ messageText }) => messageText,
      );
      expect(new Set(messages).size).toBe(messages.length);
      expect(messages.length).toBeGreaterThan(0);
    }
  });
});

describe("a file reading a macro module with errors", () => {
  test("comes back empty, with the reason, not as source to parse", () => {
    const { config, file } = project({
      "macros.sts": "export syntax a:expr { rule { a $x:nosuch } => { 1 } }\n",
      "main.sts":
        'import { a } from "./macros.sts" for syntax;\nexport const r = a 1;\n',
    });
    const answer = opened(config).transform(file("main.sts"));
    expect(answer.text).toBe("");
    expect(answer.mappings).toEqual([]);
    expect(answer.diagnostics).toHaveLength(1);
    expect(answer.diagnostics?.[0]?.start).toBe(0);
  });
});

describe("a project that references another", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const library = {
    "macros.sts": "export syntax one:expr { rule { one } => { 1 } }\n",
    "main.sts": "",
    "util.sts":
      'import { one } from "./macros.sts" for syntax;\nexport const u = one;\n',
  };
  function configureLibrary(config: string, extra: object = {}) {
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          composite: true,
        },
        include: ["*.sts"],
        ...extra,
      }),
    );
  }
  function referencing(references: readonly string[], text = "export {};\n") {
    const app = project({ "main.sts": text });
    writeFileSync(
      app.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["main.sts"],
        references: references.map((path) => ({ path })),
      }),
    );
    return app;
  }
  const open = (mapper: SweetenerContentMapper, config: string) =>
    mapper.openProject({
      configFileName: config,
      projectHandle: "p",
      compilerOptions: {},
    });

  test("expands its files by the config that lists them", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const answer = opened(referencing([lib.directory]).config).transform(
      lib.file("util.sts"),
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.text).toContain("export const u = 1;");
  });

  test("watches what those files read from the first open, whose identity stands", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const app = referencing([lib.directory]);
    const { mapper, result, transform } = opened(app.config);
    expect(result.watchedFiles).toEqual(
      expect.arrayContaining([lib.file("macros.sts"), lib.config]),
    );
    transform(lib.file("util.sts"));
    expect(open(mapper, app.config).configIdentity).toBe(result.configIdentity);
    writeFileSync(
      lib.file("macros.sts"),
      "export syntax one:expr { rule { one } => { 2 } }\n",
    );
    expect(open(mapper, app.config).configIdentity).not.toBe(
      result.configIdentity,
    );
    expect(transform(lib.file("util.sts")).text).toContain(
      "export const u = 2;",
    );
  });

  test("keeps every project it references, however many", () => {
    const libraries = Array.from({ length: 12 }, () => {
      const lib = project(library);
      configureLibrary(lib.config);
      return lib;
    });
    const app = referencing(libraries.map(({ directory }) => directory));
    const { mapper, result } = opened(app.config);
    const expand = vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    );
    const again = open(mapper, app.config);
    expect(expand).not.toHaveBeenCalled();
    expect(again.configIdentity).toBe(result.configIdentity);
    for (const { file } of libraries)
      expect(again.watchedFiles).toContain(file("macros.sts"));
  });

  test("brings them up to date at the open, and only there", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const app = referencing([lib.directory]);
    const { transform } = opened(app.config);
    const stats = vi.spyOn(ts.sys, "readDirectory");
    const expand = vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    );
    transform(lib.file("util.sts"));
    transform(lib.file("util.sts"));
    expect(expand).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
  });

  test("says what is wrong with a referenced config, and watches it", () => {
    const lib = project(library);
    configureLibrary(lib.config, { sweet: { macroExtensions: 7 } });
    const app = referencing([lib.directory]);
    const { result, transform } = opened(app.config);
    expect(result.watchedFiles).toContain(lib.config);
    expect(transform(lib.file("util.sts")).diagnostics).toEqual([
      expect.objectContaining({
        code: 6001,
        messageText: expect.stringContaining(lib.config),
      }),
    ]);
  });

  test("a config changing does not lose what it references", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const app = referencing([lib.directory]);
    const { transform } = opened(app.config);
    writeFileSync(
      app.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2020" },
        include: ["main.sts"],
        references: [{ path: lib.directory }],
      }),
    );
    writeFileSync(app.file("new.sts"), "export {};\n");
    transform(app.file("new.sts"));
    expect(transform(lib.file("util.sts")).diagnostics).toEqual([]);
  });

  test("a project of plain files costs nothing to reference", () => {
    const lib = project({
      "plain.ts": "export const p = 1;\n",
      "macros.sts": "",
      "main.sts": "",
    });
    writeFileSync(
      lib.config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          composite: true,
        },
        include: ["*.ts"],
      }),
    );
    const reads = vi.spyOn(ts.sys, "readFile");
    opened(referencing([lib.directory]).config);
    expect(reads.mock.calls.map(([path]) => path)).not.toContain(
      lib.file("plain.ts"),
    );
  });

  test("names the config that lists a file when it will not expand it", () => {
    const lib = project({ ...library, "b.stsx": "export const b = 1;\n" });
    writeFileSync(
      lib.config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          composite: true,
        },
        files: ["b.stsx", "util.sts", "macros.sts"],
        sweet: { macroExtensions: [".sts"] },
      }),
    );
    const { transform } = opened(referencing([lib.directory]).config);
    const answer = transform(lib.file("b.stsx"));
    expect(answer.diagnostics?.[0]?.messageText).toContain(
      `${lib.config} maps .stsx`,
    );
  });

  test("lets go of a reference the config no longer has", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const app = referencing([lib.directory]);
    const { mapper, result } = opened(app.config);
    expect(result.watchedFiles).toContain(lib.file("macros.sts"));
    writeFileSync(
      app.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["main.sts"],
      }),
    );
    expect(open(mapper, app.config).watchedFiles).not.toContain(
      lib.file("macros.sts"),
    );
  });

  test("finds a file newly written in a project it references", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const { transform } = opened(referencing([lib.directory]).config);
    writeFileSync(lib.file("later.sts"), "export const l = 1;\n");
    const answer = transform(lib.file("later.sts"));
    expect(answer.diagnostics).toEqual([]);
    expect(answer.text).toContain("export const l = 1;");
  });

  test("still refuses what no project in the chain lists", () => {
    const lib = project(library);
    configureLibrary(lib.config);
    const { transform } = opened(referencing([lib.directory]).config);
    expect(
      transform(project().file("stray.sts"), "export {};\n").diagnostics,
    ).toEqual([expect.objectContaining({ code: 6202 })]);
  });
});

describe("a file with a directive", () => {
  test("is not counted, since TypeScript reads it as written", () => {
    const { config, file } = project({
      "only.sts": "export syntax one:expr { rule { one } => { 1 } }\n",
      "directive.ts":
        '"use sweetener";\nimport { one } from "./only.sts" for syntax;\nexport const d = one;\n',
    });
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["*.sts", "*.ts"],
      }),
    );
    const { result } = opened(config);
    expect(result.watchedFiles).not.toContain(file("only.sts"));
  });
});

describe("a file that changes on disk as it is expanded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("is answered for the text TypeScript sent", () => {
    const { config, file } = project();
    const { transform } = opened(config);
    const expand = DefaultProjectExpansionProvider.prototype.expandProject;
    const sent = `${main}export const sent = 1;\n`;
    vi.spyOn(
      DefaultProjectExpansionProvider.prototype,
      "expandProject",
    ).mockImplementationOnce(function (
      this: DefaultProjectExpansionProvider,
      project,
      options,
    ) {
      writeFileSync(file("main.sts"), `${main}export const saved = 1;\n`);
      return expand.call(this, project, options);
    });
    const answer = transform(file("main.sts"), sent);
    expect(answer.text).toContain("sent = 1");
    expect(answer.text).not.toContain("saved = 1");
  });
});

describe("a file TypeScript does not transform", () => {
  test.each([".mts", ".cts"])(
    "a directive in a %s fails nothing, and costs no other file",
    (extension) => {
      const { config, file } = project({
        [`directive${extension}`]:
          '"use sweetener";\nexport const d: number = 1;\n',
      });
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: { module: "ESNext", target: "ES2022", strict: true },
          include: ["*.sts", `*${extension}`],
        }),
      );
      const { mapper, result, transform } = opened(config);
      expect(transform(file("main.sts")).diagnostics).toEqual([]);
      // Not counted as read, so typing elsewhere changes nothing.
      transform(file("main.sts"), `${main}// typed\n`);
      expect(
        mapper.openProject({
          configFileName: config,
          projectHandle: "p",
          compilerOptions: {},
        }).configIdentity,
      ).toBe(result.configIdentity);
    },
  );
});

describe("errors raised against a macro's template", () => {
  test("are reported by the file using it, which alone raises them", () => {
    const { config, file } = project({
      "macros.sts":
        "export syntax pick:stmt { rule { pick $k:tt; } => { $k / (g) / 2; } }\n",
      "main.sts":
        'import { pick } from "./macros.sts" for syntax;\nconst x = 1, g = 2;\npick x;\nfunction f() { pick return; }\n',
    });
    const { transform } = opened(config);
    const fromUse = transform(file("main.sts")).diagnostics ?? [];
    expect(
      fromUse.filter(({ messageText }) =>
        messageText.startsWith(`${file("macros.sts")}:`),
      ),
    ).toHaveLength(1);
    expect(transform(file("macros.sts")).diagnostics).toEqual([]);
  });
});

describe("errors in other files", () => {
  const helpers = `export syntax shout:expr {
  rule { shout($value:expr) } => { $value.toUpperCase( }
}
`;
  const user = `import { shout } from "./helpers.stsx" for syntax;
export const loud = shout("a");
`;
  /** A project whose macro module is a .stsx. */
  function reportedByUser(contentMappers: readonly unknown[]) {
    const { directory, file } = project({
      "helpers.stsx": helpers,
      "main.sts": user,
    });
    const tsconfig = join(directory, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          jsx: "preserve",
        },
        include: ["main.sts", "helpers.stsx"],
        contentMappers,
      }),
    );
    const { transform } = opened(tsconfig);
    return transform(file("main.sts")).diagnostics?.map(
      ({ messageText }) => messageText,
    );
  }
  const expected = [
    expect.stringMatching(/helpers\.stsx:2:54: Missing closing delimiter \)$/u),
  ];

  test("reports an error in a module TypeScript never transforms here", () => {
    expect(
      reportedByUser([
        { package: "@sweetener/content-mapper", extensions: [".sts"] },
      ]),
    ).toEqual(expected);
  });

  // An editor asks about the files that are open, and this is why the file
  // using the macro did not expand.
  test("reports an error in a module that also reports it", () => {
    expect(
      reportedByUser([
        { package: "@sweetener/content-mapper", extensions: [".sts", ".stsx"] },
      ]),
    ).toEqual(expected);
  });
});

describe("binding agreement", () => {
  test("names that resolve to nothing prove nothing", () => {
    // `ext.x` is a property of something untyped and `x` a global: both
    // resolve to nothing, and they are not one binding.
    const text = "declare const ext: any;\next.x;\nx;\n";
    const at = (from: number) => {
      const start = text.indexOf("x", from);
      return { start, end: start + 1 };
    };
    const { agree } = createBindingAgreement(text, ".ts");
    const property = at(text.indexOf("ext.x") + 4);
    const global = at(text.indexOf("\nx;") + 1);
    expect(agree([property, global])).toBe(false);
  });

  test("copies of one declared name agree", () => {
    const text = "const x = 1;\nx;\nx;\n";
    const first = text.indexOf("\nx;") + 1;
    const second = text.lastIndexOf("\nx;") + 1;
    expect(
      createBindingAgreement(text, ".ts").agree([
        { start: first, end: first + 1 },
        { start: second, end: second + 1 },
      ]),
    ).toBe(true);
  });
});

describe("span maps TypeScript accepts", () => {
  const segment = (
    virtualStart: number,
    originalStart: number,
    originalEnd: number,
    kind: Segment["kind"],
    features: number = SpanMapFeature.All,
  ): Segment => ({
    virtualStart,
    virtualEnd: virtualStart + 1,
    originalStart,
    originalEnd,
    kind,
    features,
  });

  test("segments may share one original span", () => {
    const shared = [
      segment(0, 4, 6, SpanMapKind.Atom, SpanMapFeature.None),
      segment(1, 4, 6, SpanMapKind.Verbatim),
    ];
    expect(compatibleSegments(shared)).toEqual(shared);
  });

  test("where spans collide, the verbatim one keeps its span", () => {
    const wide = segment(0, 0, 10, SpanMapKind.Atom, SpanMapFeature.None);
    const exact = segment(5, 2, 4, SpanMapKind.Verbatim);
    expect(compatibleSegments([wide, exact])).toEqual([exact]);
  });

  test("an empty span inside another collides, and at its edge does not", () => {
    const token = segment(0, 2, 4, SpanMapKind.Verbatim);
    expect(
      compatibleSegments([token, segment(1, 3, 3, SpanMapKind.Atom)]),
    ).toEqual([token]);
    const edge = segment(1, 4, 4, SpanMapKind.Atom);
    expect(compatibleSegments([token, edge])).toEqual([token, edge]);
  });

  test("UTF-8 offsets count bytes and never split a surrogate pair", () => {
    const encode = offsetEncoder("aé🍬b", "utf-8");
    expect([0, 1, 2, 4, 5].map(encode)).toEqual([0, 1, 3, 7, 8]);
    expect(offsetEncoder("aé", "utf-16")(2)).toBe(2);
    // A surrogate on its own reaches TypeScript as U+FFFD, three bytes.
    expect(offsetEncoder("a\ud800b", "utf-8")(2)).toBe(4);
    expect(offsetEncoder("a\udc00b", "utf-8")(2)).toBe(4);
    expect(offsetEncoder("a\ud800\ud800b", "utf-8")(3)).toBe(7);
  });
});

/**
 * Every example the repository ships, expanded the way TypeScript asks for
 * it and checked against TypeScript's own rules for a span map. A mapping
 * TypeScript refuses costs the whole file in an editor, so each one that would
 * be refused is a failure here, named by file.
 */
describe("the examples", () => {
  const configs = [
    "examples/language-tour/sweetener.json",
    "examples/library-macros/sweetener.json",
    "examples/react-memoization/sweetener.json",
    "examples/vite-react/sweetener.json",
  ];
  test.each(configs)("%s maps every file acceptably", (relativeConfig) => {
    const config = join(repositoryRoot, relativeConfig);
    const { transform } = opened(config);
    const sources = loadSweetProject(config).typescript.fileNames.filter(
      (name) => /\.stsx?$/u.test(name),
    );
    expect(sources.length).toBeGreaterThan(0);
    const problems = sources.flatMap((fileName) => {
      const original = readFileSync(fileName, "utf8");
      const result = transform(fileName);
      const problem = spanMapProblem(result.mappings, result.text, original);
      return problem === undefined ? [] : [`${fileName}: ${problem}`];
    });
    expect(problems).toEqual([]);
  });
});
