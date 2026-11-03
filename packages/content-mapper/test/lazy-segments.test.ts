import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createBindingAgreement } from "../src/binding-agreement.js";
import type * as BindingAgreement from "../src/binding-agreement.js";
import { SweetenerContentMapper } from "../src/mapper.js";

vi.mock("../src/binding-agreement.js", async (original) => {
  const actual = await original<typeof BindingAgreement>();
  return {
    ...actual,
    createBindingAgreement: vi.fn(actual.createBindingAgreement),
  };
});

/**
 * An editor asks for the files it has open, and deciding what the names in one
 * mean can take a program of its own, so opening a project does that for none.
 */
test("works out what names mean only for a file asked for", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sweet-lazy-")));
  const write = (name: string, text: string) => {
    writeFileSync(join(directory, name), text);
    return join(directory, name);
  };
  write(
    "twice.sts",
    "export syntax twice:expr { rule { twice($v:expr) } => { [$v, $v] } }\n",
  );
  const text = `import { twice } from "./twice.sts" for syntax;\nconst v = 1;\nexport const w = twice(v);\n`;
  const use = write("use.sts", text);
  write("other.sts", "export const o = 1;\n");
  const config = write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022" },
      include: ["*.sts"],
    }),
  );
  const mapper = new SweetenerContentMapper();
  mapper.initialize({ protocolVersion: 1, positionEncodings: ["utf-16"] });
  mapper.openProject({
    configFileName: config,
    projectHandle: "p",
    compilerOptions: {},
  });
  expect(createBindingAgreement).not.toHaveBeenCalled();
  const ask = () =>
    mapper.transform({ fileName: use, content: text, projectHandle: "p" });
  expect(ask().mappings.length).toBeGreaterThan(0);
  expect(createBindingAgreement).toHaveBeenCalledTimes(1);
  // Worked out once, for as long as the expansion stands.
  ask();
  expect(createBindingAgreement).toHaveBeenCalledTimes(1);
});
