import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { packageIdentity } from "../src/package-identity.js";

test("names the package a module ships in, past a manifest that names none", () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-jest-identity-"));
  mkdirSync(join(root, "dist", "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@acme/compiler", version: "1.2.3" }),
  );
  writeFileSync(
    join(root, "dist", "package.json"),
    JSON.stringify({ type: "module" }),
  );
  const entry = join(root, "dist", "src", "index.js");
  writeFileSync(entry, "export {};\n");
  expect(packageIdentity(pathToFileURL(entry).href)).toBe(
    "@acme/compiler@1.2.3",
  );
});
