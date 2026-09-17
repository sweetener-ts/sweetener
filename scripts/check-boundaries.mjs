#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function workspaceDependencies(manifest) {
  const sections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ];
  return sections.flatMap((section) =>
    Object.keys(section ?? {}).filter((name) => name.startsWith("@sweetener/")),
  );
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const active = new Set();
  const stack = [];

  function visit(packageName) {
    if (active.has(packageName)) {
      const start = stack.indexOf(packageName);
      cycles.push([...stack.slice(start), packageName]);
      return;
    }
    if (visited.has(packageName)) return;

    visited.add(packageName);
    active.add(packageName);
    stack.push(packageName);
    for (const dependency of graph.get(packageName) ?? []) {
      if (graph.has(dependency)) visit(dependency);
    }
    stack.pop();
    active.delete(packageName);
  }

  for (const packageName of [...graph.keys()].sort()) visit(packageName);
  return cycles;
}

/** Every module specifier the file actually imports from, statically or not. */
function importedSpecifiers(fileName, source) {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return specifiers;
}

export async function checkPackageBoundaries(repositoryRoot) {
  const packagesDirectory = join(repositoryRoot, "packages");
  const errors = [];
  const graph = new Map();

  for (const packageEntry of await readdir(packagesDirectory, {
    withFileTypes: true,
  })) {
    if (!packageEntry.isDirectory()) continue;
    const packageRoot = join(packagesDirectory, packageEntry.name);
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    graph.set(manifest.name, workspaceDependencies(manifest));

    for (const file of await filesBelow(packageRoot)) {
      const source = await readFile(file, "utf8");
      // Parsed rather than matched: read as text, an import specifier is
      // indistinguishable from the same words quoted inside a string, and
      // documentation that shows someone what to import would be reported as
      // importing it.
      for (const specifier of importedSpecifiers(file, source)) {
        if (
          specifier.startsWith("@sweetener/") &&
          specifier.split("/").length > 2
        )
          errors.push(
            `${relative(repositoryRoot, file)} imports internal package path ${specifier}`,
          );
        if (/^(?:\.\.\/){3,}packages\//u.test(specifier))
          errors.push(
            `${relative(repositoryRoot, file)} uses a relative cross-package import`,
          );
      }
    }
  }

  for (const cycle of findCycles(graph)) {
    errors.push(`workspace package cycle: ${cycle.join(" -> ")}`);
  }
  return errors.sort();
}

async function main() {
  const rootIndex = process.argv.indexOf("--root");
  const repositoryRoot =
    rootIndex >= 0 && process.argv[rootIndex + 1]
      ? resolve(process.argv[rootIndex + 1])
      : resolve(scriptDirectory, "..");
  const errors = await checkPackageBoundaries(repositoryRoot);

  if (errors.length > 0) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Package boundary check passed.\n");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
