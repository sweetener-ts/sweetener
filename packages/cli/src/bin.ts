#!/usr/bin/env node
import { readSync } from "node:fs";
import { resolve } from "node:path";
import { runCli } from "./command-line.js";
import { serveLanguageServer } from "./language-server.js";

/**
 * Reads one line of an answer from the terminal.
 *
 * Synchronous because the commands are, and reading a byte at a time because
 * anything buffered would swallow input the shell still needs afterwards.
 */
function askOnTerminal(question: string): boolean {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(question);
  const byte = Buffer.alloc(1);
  let answer = "";
  for (;;) {
    let read: number;
    try {
      read = readSync(0, byte, 0, 1, null);
    } catch {
      return false;
    }
    if (read === 0) break;
    const character = byte.toString("utf8");
    if (character === "\n" || character === "\r") break;
    answer += character;
  }
  process.stdout.write("\n");
  return /^y(?:es)?$/iu.test(answer.trim());
}

const result = runCli({
  argv: process.argv.slice(2),
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    // Only where there is a terminal to answer. Everywhere else a command that
    // would write says so and stops, rather than taking silence for consent.
    ...(process.stdin.isTTY ? { confirm: askOnTerminal } : {}),
  },
});

if (result.lsp !== undefined) {
  try {
    serveLanguageServer(resolve(result.lsp), process.stdin, process.stdout);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
} else {
  process.exitCode = result.exitCode;
}
