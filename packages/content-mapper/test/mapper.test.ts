import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSweetProject } from "@sweetener/compiler";
import { describe, expect, test } from "vitest";
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
      diagnosticSource: "sweetener",
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

describe("errors in other files", () => {
  const helpers = `export syntax shout:expr {
  rule { shout($value:expr) } => { $value.toUpperCase( }
}
`;
  const user = `import { shout } from "./helpers.stsx" for syntax;
export const loud = shout("a");
`;
  /** A project whose macro module is a .stsx, claimed by `contentMappers` or not. */
  function withModule(config: Record<string, unknown>, base?: unknown) {
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
        ...config,
      }),
    );
    if (base !== undefined)
      writeFileSync(join(directory, "base.json"), JSON.stringify(base));
    const { transform } = opened(tsconfig);
    return transform(file("main.sts")).diagnostics?.map(
      ({ messageText }) => messageText,
    );
  }
  const both = {
    contentMappers: [
      { package: "@sweetener/content-mapper", extensions: [".sts", ".stsx"] },
    ],
  };

  test("reports an error in a module TypeScript never transforms here", () => {
    const reported = withModule({
      contentMappers: [
        { package: "@sweetener/content-mapper", extensions: [".sts"] },
      ],
    });
    expect(reported).toEqual([
      expect.stringMatching(
        /helpers\.stsx\(2,54\): Missing closing delimiter \)$/u,
      ),
    ]);
  });

  test("leaves an error in a module it transforms to that module", () => {
    expect(withModule(both)).toEqual([]);
  });

  test("reads the claimed extensions through extends, as TypeScript does", () => {
    expect(withModule({ extends: "./base" }, both)).toEqual([]);
    // A config's own entry is the one that counts.
    expect(
      withModule(
        {
          extends: "./base",
          contentMappers: [
            { package: "@sweetener/content-mapper", extensions: [".sts"] },
          ],
        },
        both,
      ),
    ).toHaveLength(1);
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
    const agree = createBindingAgreement(text, ".ts");
    const property = at(text.indexOf("ext.x") + 4);
    const global = at(text.indexOf("\nx;") + 1);
    expect(agree([property, global])).toBe(false);
  });

  test("copies of one declared name agree", () => {
    const text = "const x = 1;\nx;\nx;\n";
    const first = text.indexOf("\nx;") + 1;
    const second = text.lastIndexOf("\nx;") + 1;
    expect(
      createBindingAgreement(
        text,
        ".ts",
      )([
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
