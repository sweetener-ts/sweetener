#!/usr/bin/env node
import { resolve } from "node:path";
import { serveLanguageServer } from "./language-server.js";

const directory = process.argv[2];
if (directory === undefined || directory.length === 0) {
  process.stderr.write("usage: sweetener-lsp <project-directory>\n");
  process.exit(1);
}

try {
  serveLanguageServer(resolve(directory), process.stdin, process.stdout);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
