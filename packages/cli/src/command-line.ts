import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  scaffoldIntoProject,
  scaffoldProject,
  writeScaffold,
} from "./scaffold.js";
import type { System } from "typescript";
import * as ts from "typescript";
import {
  runConfiguredProjectCommand,
  watchConfiguredProject,
  type ProjectExpansionProvider,
  type WatchProject,
} from "./project-command.js";
import {
  expansionView,
  explainOriginalPosition,
  parseSourcePosition,
  sourceOffset,
  type ExpansionInspectionProvider,
} from "./expansion-tools.js";
import { createDefaultProjectExpansionProvider } from "./default-expansion-provider.js";
import { loadSweetProject } from "./configuration.js";
import { emitStandalone } from "./standalone-emit.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /**
   * Asks before anything is written. Absent when there is nobody to ask, in
   * which case a command that would write refuses instead of assuming.
   */
  readonly confirm?: ((question: string) => boolean) | undefined;
}

export type CliInvocation =
  | {
      readonly command: "check" | "build" | "watch";
      readonly configPath: string;
      readonly debug: boolean;
    }
  | {
      readonly command: "init";
      readonly directory: string;
      readonly assumeYes: boolean;
    }
  | {
      readonly command: "expand";
      readonly fileName: string;
      readonly configPath?: string | undefined;
    }
  | {
      readonly command: "explain";
      readonly position: string;
      readonly configPath?: string | undefined;
    }
  | { readonly command: "help" }
  | {
      readonly command: "emit";
      readonly fileNames: readonly string[];
      readonly outDir: string;
    };

/**
 * Pull `-p`/`--project` out of an argument list.
 *
 * `expand` and `explain` used to reject it, and only ever discovered a
 * `tsconfig.json`. `init` writes `sweetener.json`, so in a scaffolded project
 * two of the commands could not read the config the other four were using.
 */
function splitProjectOption(argv: readonly string[]): {
  readonly positional: readonly string[];
  readonly configPath: string | undefined;
} {
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-p" || argument === "--project") {
      const value = argv[++index];
      if (value === undefined)
        throw new TypeError(`${argument} requires a path`);
      configPath = value;
    } else if (argument.startsWith("-"))
      throw new TypeError(`Unknown argument ${argument}`);
    else positional.push(argument);
  }
  return { positional: Object.freeze(positional), configPath };
}

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  const command = argv[0];
  if (command === "init") {
    const rest = argv.slice(1);
    const assumeYes = rest.some(
      (argument) => argument === "--yes" || argument === "-y",
    );
    const directories = rest.filter(
      (argument) => argument !== "--yes" && argument !== "-y",
    );
    if (directories.length > 1)
      throw new TypeError("init takes at most one directory");
    return Object.freeze({
      command,
      directory: directories[0] ?? ".",
      assumeYes,
    });
  }
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  )
    return Object.freeze({ command: "help" });
  if (command === "expand") {
    const { positional, configPath } = splitProjectOption(argv.slice(1));
    if (positional.length !== 1)
      throw new TypeError("expand requires one source file");
    return Object.freeze({
      command,
      fileName: positional[0]!,
      ...(configPath === undefined ? {} : { configPath }),
    });
  }
  if (command === "emit") {
    const fileNames: string[] = [];
    let outDir: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index]!;
      if (argument === "--out-dir") {
        const value = argv[++index];
        if (value === undefined)
          throw new TypeError("--out-dir requires a directory");
        outDir = value;
      } else if (argument.startsWith("-"))
        throw new TypeError(`Unknown argument ${argument}`);
      else fileNames.push(argument);
    }
    if (fileNames.length === 0)
      throw new TypeError("emit requires at least one source file");
    // Required rather than defaulted to the source directory: a file that
    // opted in with a directive keeps its own name, so emitting alongside it
    // would overwrite the input.
    if (outDir === undefined) throw new TypeError("emit requires --out-dir");
    return Object.freeze({
      command,
      fileNames: Object.freeze(fileNames),
      outDir,
    });
  }
  if (command === "explain") {
    const { positional, configPath } = splitProjectOption(argv.slice(1));
    if (positional.length !== 1)
      throw new TypeError("explain requires one file:line:column position");
    parseSourcePosition(positional[0]!);
    return Object.freeze({
      command,
      position: positional[0]!,
      ...(configPath === undefined ? {} : { configPath }),
    });
  }
  if (command !== "check" && command !== "build" && command !== "watch")
    throw new TypeError(
      "Expected init, check, build, watch, expand, explain, or emit command",
    );
  let configPath = "tsconfig.json";
  let debug = false;
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--debug") debug = true;
    else if (argument === "-p" || argument === "--project") {
      const value = argv[++index];
      if (value === undefined)
        throw new TypeError(`${argument} requires a path`);
      configPath = value;
    } else throw new TypeError(`Unknown argument ${argument}`);
  }
  return Object.freeze({ command, configPath, debug });
}

function at(file: ts.SourceFile, start: number): string {
  const position = file.getLineAndCharacterOfPosition(start);
  return `${file.fileName}:${String(position.line + 1)}:${String(position.character + 1)}`;
}

function renderDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const head =
    diagnostic.file === undefined || diagnostic.start === undefined
      ? `TS${String(diagnostic.code)}: ${message}`
      : `${at(diagnostic.file, diagnostic.start)} TS${String(diagnostic.code)}: ${message}`;
  // A diagnostic that points somewhere else as well — the rule that wanted
  // different syntax, the binding already holding a name — is most of the
  // answer, and printing only the first line threw that away.
  const related = (diagnostic.relatedInformation ?? []).map((entry) => {
    const text = ts.flattenDiagnosticMessageText(entry.messageText, "\n");
    return entry.file === undefined || entry.start === undefined
      ? `  ${text}`
      : `  ${at(entry.file, entry.start)} ${text}`;
  });
  return [head, ...related].join("\n");
}

const usage = `sweetener — hygienic declarative macros for TypeScript

Usage: sweetener <command> [options]

Commands:
  init [directory]        Scaffold a project. Shows what it would write; pass
                          --yes to write it.
  check                   Type-check the project through the official compiler.
  build                   Check, then expand and emit.
  watch                   Rebuild as sources and macros change.
  expand <file>           Print the expanded TypeScript for one source.
  explain <file:line:col> Report where a position came from, and through which
                          macros.
  emit <files...>         Expand named files into a directory, without checking.

Options:
  -p, --project <path>    Project config to use. Defaults to the nearest
                          tsconfig.json; \`init\` writes sweetener.json, so pass
                          it here.
  --yes, -y               For init: write the files rather than listing them.
  --out-dir <dir>         For emit: where to write. Required.
  --debug                 Print the expansion's internal state after the run.
  -h, --help              Show this.
`;

export function runCli(options: {
  readonly argv: readonly string[];
  readonly expansionProvider?: ProjectExpansionProvider | undefined;
  readonly inspectionProvider?: ExpansionInspectionProvider | undefined;
  readonly io: CliIo;
  readonly system?: System;
}): { readonly exitCode: 0 | 1; readonly watch?: WatchProject } {
  const expansionProvider =
    options.expansionProvider ?? createDefaultProjectExpansionProvider();
  const inspectionProvider =
    options.inspectionProvider ??
    ("inspectSource" in expansionProvider
      ? (expansionProvider as ProjectExpansionProvider &
          ExpansionInspectionProvider)
      : undefined);
  let invocation: CliInvocation;
  try {
    invocation = parseCliInvocation(options.argv);
  } catch (error) {
    options.io.stderr(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return Object.freeze({ exitCode: 1 });
  }
  if (invocation.command === "help") {
    options.io.stdout(usage);
    return Object.freeze({ exitCode: 0 });
  }
  const report = (result: ReturnType<typeof runConfiguredProjectCommand>) => {
    for (const diagnostic of result.diagnostics)
      options.io.stderr(`${renderDiagnostic(diagnostic)}\n`);
    if ("debug" in invocation && invocation.debug)
      options.io.stdout(`${JSON.stringify(result.debugState, null, 2)}\n`);
    options.io.stdout(
      `${result.command}: ${result.exitCode === 0 ? "success" : "failed"}\n`,
    );
  };
  if (invocation.command === "emit") {
    const result = emitStandalone({
      fileNames: invocation.fileNames,
      outDir: invocation.outDir,
      expansionProvider,
    });
    for (const diagnostic of result.diagnostics)
      options.io.stderr(`${renderDiagnostic(diagnostic)}\n`);
    if (result.diagnostics.length > 0) {
      options.io.stdout("emit: failed\n");
      return Object.freeze({ exitCode: 1 });
    }
    for (const fileName of result.outputs.keys())
      options.io.stdout(`${fileName}\n`);
    options.io.stdout("emit: success\n");
    return Object.freeze({ exitCode: 0 });
  }
  if (invocation.command === "init") {
    try {
      // A project that already builds itself gets what it is missing, not a
      // refusal: adding macros to something that exists is the ordinary case,
      // and starting from nothing is the rare one.
      const manifestPath = resolve(invocation.directory, "package.json");
      const existing = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          })
        : undefined;
      // A project built for a runtime that needs no package.json is still a
      // project, and writing one into it would be the wrong thing entirely.
      const settled =
        existing !== undefined ||
        ["deno.json", "deno.jsonc", "bunfig.toml", "tsconfig.json"].some(
          (name) => existsSync(resolve(invocation.directory, name)),
        );
      const project = settled
        ? scaffoldIntoProject({
            directory: invocation.directory,
            manifest: existing,
          })
        : scaffoldProject({ directory: invocation.directory });

      // Said in full before anything happens, because this writes into a
      // directory someone else owns.
      options.io.stdout(
        `${[
          `In ${resolve(invocation.directory)} this will create:`,
          ...project.files.map(({ path }) => `  ${path}`),
          "",
          "It will not modify or delete anything already there.",
          "",
        ].join("\n")}`,
      );
      if (!invocation.assumeYes) {
        if (options.io.confirm === undefined) {
          options.io.stderr(
            "Nothing here can ask for confirmation. Re-run with --yes to write these files.\n",
          );
          return Object.freeze({ exitCode: 1 });
        }
        if (!options.io.confirm("Create them? [y/N] ")) {
          options.io.stdout("Nothing was written.\n");
          return Object.freeze({ exitCode: 0 });
        }
      }
      const written = writeScaffold(project, invocation.directory);
      options.io.stdout(
        `${[
          "Created:",
          ...written.map((path: string) => `  ${path}`),
          "",
          // A note may carry a block to paste into a config file. Only its
          // first line is a bullet; the rest is printed as it should appear.
          ...project.notes.map((note: string) =>
            note
              .split("\n")
              .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
              .join("\n"),
          ),
          "",
        ].join("\n")}`,
      );
      return Object.freeze({ exitCode: 0 });
    } catch (error) {
      options.io.stderr(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return Object.freeze({ exitCode: 1 });
    }
  }
  if (invocation.command === "expand" || invocation.command === "explain") {
    if (inspectionProvider === undefined) {
      options.io.stderr("Expansion inspection is unavailable\n");
      return Object.freeze({ exitCode: 1 });
    }
    // Expanding the named project first is what makes `-p` mean anything: the
    // inspection provider answers about files it has already expanded, and on
    // its own it only ever discovers a tsconfig.json.
    if (invocation.configPath !== undefined) {
      if (!("expandProject" in inspectionProvider)) {
        options.io.stderr("This expansion provider cannot load a project\n");
        return Object.freeze({ exitCode: 1 });
      }
      try {
        (
          inspectionProvider as unknown as ProjectExpansionProvider
        ).expandProject(loadSweetProject(resolve(invocation.configPath)));
      } catch (error) {
        options.io.stderr(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return Object.freeze({ exitCode: 1 });
      }
    }
    const position =
      invocation.command === "explain"
        ? parseSourcePosition(invocation.position)
        : undefined;
    const fileName =
      invocation.command === "expand"
        ? invocation.fileName
        : position!.fileName;
    const inspected =
      inspectionProvider.inspectSource(fileName) ??
      ("prepareSource" in inspectionProvider &&
      typeof inspectionProvider.prepareSource === "function"
        ? (
            inspectionProvider.prepareSource as (
              source: string,
            ) => ReturnType<ExpansionInspectionProvider["inspectSource"]>
          )(fileName)
        : undefined);
    if (inspected === undefined) {
      options.io.stderr(`No expansion available for ${fileName}\n`);
      return Object.freeze({ exitCode: 1 });
    }
    // Printing the source, or an account of where it came from, and reporting
    // success would say the macros ran. `explain` used to report the origins of
    // an expansion that never happened, which reads as an expansion in which
    // every token came from the source -- exactly what an unexpanded file looks
    // like.
    if (inspected.diagnostics.length > 0) {
      for (const diagnostic of inspected.diagnostics)
        options.io.stderr(`${renderDiagnostic(diagnostic)}\n`);
      return Object.freeze({ exitCode: 1 });
    }
    if (invocation.command === "expand") {
      options.io.stdout(expansionView(inspected.generated));
    } else {
      // A position past the end of the file is something a person types, not
      // an internal fault: it used to escape as a raw stack trace naming dist
      // paths.
      let offset: number;
      try {
        offset = sourceOffset(
          inspected.sourceText,
          position!.line,
          position!.column,
        );
      } catch {
        const lines = inspected.sourceText.split("\n").length;
        options.io.stderr(
          `${fileName} has ${String(lines)} line${lines === 1 ? "" : "s"}; ` +
            `${String(position!.line)}:${String(position!.column)} is outside it\n`,
        );
        return Object.freeze({ exitCode: 1 });
      }
      options.io.stdout(
        `${JSON.stringify(
          explainOriginalPosition({
            sourceId: inspected.sourceId,
            offset,
            index: inspected.index,
            trace: inspected.trace,
            generatedNames: inspected.generatedNames,
          }),
          null,
          2,
        )}\n`,
      );
    }
    return Object.freeze({ exitCode: 0 });
  }
  if (invocation.command === "watch") {
    const watch = watchConfiguredProject({
      configPath: invocation.configPath,
      expansionProvider,
      onResult: report,
      ...(options.system === undefined ? {} : { system: options.system }),
    });
    return Object.freeze({ exitCode: watch.result.exitCode, watch });
  }
  const result = runConfiguredProjectCommand({
    command: invocation.command,
    configPath: invocation.configPath,
    expansionProvider,
  });
  report(result);
  return Object.freeze({ exitCode: result.exitCode });
}
