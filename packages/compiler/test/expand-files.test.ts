import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Expanding one file on its own is how an editor keeps up with typing, so it
 * has to say exactly what expanding the whole project says about that file:
 * the same text, the same source behind every printed region, the same
 * diagnostics, and the same inputs to keep it against.
 */
test("expanding one file alone matches expanding the project", () => {
  const configs = [
    "examples/language-tour/sweetener.json",
    "examples/library-macros/sweetener.json",
    "examples/react-memoization/sweetener.json",
    "examples/vite-react/sweetener.json",
  ].map((config) => join(repository, config));
  let compared = 0;
  for (const config of configs) {
    const project = loadSweetProject(config);
    const whole = createDefaultProjectExpansionProvider();
    whole.expandProject(project);
    // Ten from each project: every one costs a whole project's worth of
    // reading, and ten already cross operators, JSX and package macros.
    for (const fileName of project.typescript.fileNames.slice(0, 10)) {
      const expected = whole.inspectSource(fileName);
      if (expected === undefined) continue;
      const alone = createDefaultProjectExpansionProvider();
      const output = alone.expandProject(project, {
        files: new Set([resolve(fileName)]),
      });
      const actual = alone.inspectSource(fileName);
      const regions = (inspection: typeof expected) =>
        inspection.index
          .regions()
          .map(
            (region) =>
              `${region.generatedStart}-${region.generatedEnd} ${region.kind} ${region.primary.span.start}-${region.primary.span.end}`,
          );
      expect(actual?.generated.text, fileName).toBe(expected.generated.text);
      expect(regions(actual!), fileName).toEqual(regions(expected));
      expect(
        actual!.diagnostics.map(({ code, start }) => [code, start]),
        fileName,
      ).toEqual(expected.diagnostics.map(({ code, start }) => [code, start]));
      expect(actual!.inputs, fileName).toEqual(expected.inputs);
      expect(output.files.map((file) => file.fileName)).toEqual([
        expected.virtualFileName,
      ]);
      compared += 1;
    }
  }
  expect(compared).toBeGreaterThan(20);
});

/**
 * A macro module is read again once a template of it writes an element, and
 * only expanding a use of that template finds out. Skipping that file reads
 * the module the first way, which changes nothing for a file using another of
 * its macros: the reading belongs to the template, and any file using the
 * template asks for it.
 */
test("a file alone matches where only a skipped file has a macro module read again", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sweet-alone-")));
  const write = (name: string, text: string) => {
    writeFileSync(join(directory, name), text);
    return join(directory, name);
  };
  write(
    "macros.stsx",
    `export syntax el:expr { rule { el } => { <p>(optional) note</p> } }
export syntax later:expr { rule { later } => { 7 } }
`,
  );
  const plain = write(
    "plain.stsx",
    'import { later } from "./macros.stsx" for syntax;\nexport const a = later;\n',
  );
  const element = write(
    "element.stsx",
    'import { el } from "./macros.stsx" for syntax;\nexport const b = el;\n',
  );
  const config = write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
      },
      sweet: { macroExtensions: [".sts", ".stsx"] },
      files: ["macros.stsx", "plain.stsx", "element.stsx"],
    }),
  );
  const project = loadSweetProject(config);
  const whole = createDefaultProjectExpansionProvider();
  whole.expandProject(project);
  expect(whole.inspectSource(element)?.generated.text).toContain(
    "<p>(optional) note</p>",
  );
  for (const fileName of [plain, element]) {
    const alone = createDefaultProjectExpansionProvider();
    alone.expandProject(project, { files: new Set([fileName]) });
    expect(alone.inspectSource(fileName)?.generated.text).toBe(
      whole.inspectSource(fileName)?.generated.text,
    );
    expect(alone.inspectSource(fileName)?.diagnostics).toEqual([]);
  }
});

/**
 * A macro module's own use of a macro can decide how it is read: `stmt(1)` is
 * a statement, so the slash after it opens a regular expression, not the
 * division the reader took it for, and read as a division everything after it
 * is lost. Only expanding the module finds that out, so a file using it has to
 * have it expanded, and neither sees it in what comes back.
 */
test("a file alone settles how the macro modules it reads from are read", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sweet-alone-")));
  const write = (name: string, text: string) => {
    writeFileSync(join(directory, name), text);
    return join(directory, name);
  };
  write(
    "base.sts",
    "export syntax stmt:stmt { rule { stmt($v:expr) } => { $v; } }\n",
  );
  const module = write(
    "m.sts",
    `import { stmt } from "./base.sts" for syntax;
stmt(1) /{/.test("x");
export syntax foo:expr { rule { foo($v:expr) } => { $v } }
`,
  );
  const user = write(
    "a.sts",
    'import { foo } from "./m.sts" for syntax;\nexport const v = foo(1);\n',
  );
  const config = write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { noEmit: true, target: "ES2022", module: "ESNext" },
      files: ["base.sts", "m.sts", "a.sts"],
    }),
  );
  const project = loadSweetProject(config);
  const alone = createDefaultProjectExpansionProvider();
  const output = alone.expandProject(project, { files: new Set([user]) });
  const inspection = alone.inspectSource(user);
  expect(inspection?.generated.text).toContain("export const v = 1;");
  expect(inspection?.diagnostics).toEqual([]);
  expect(output.files).toHaveLength(1);
  expect(alone.inspectSource(module)).toBeUndefined();
});
