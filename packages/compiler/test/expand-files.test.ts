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
