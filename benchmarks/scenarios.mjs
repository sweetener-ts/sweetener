import { Buffer } from "node:buffer";
import {
  createReader,
  printLossless,
} from "../packages/reader/dist/src/index.js";
import { ScopeStore } from "../packages/hygiene/dist/src/index.js";
import {
  compileMatcherProgram,
  createChoicePattern,
  createLiteralPattern,
  createSequencePattern,
  createTokenLiteralKey,
  executeMatcher,
  inferCaptureShapes,
} from "../packages/pattern/dist/src/index.js";
import {
  createOriginQueryIndex,
  printExpandedFile,
} from "../packages/printer/dist/src/index.js";
import { createToken, OriginStore } from "../packages/syntax/dist/src/index.js";
import {
  ContentAddressedCompilerCache,
  createCompilerCacheKey,
  VirtualLanguageServiceProject,
} from "../packages/typescript-host/dist/src/index.js";
import ts from "typescript";
import { defineReaderBenchmarks } from "./reader.mjs";
import { defineExpansionBenchmark } from "./expansion.mjs";
import { defineProjectScaleBenchmark } from "./project-scale.mjs";
import { defineScopeStoreBenchmarks } from "./scope-store.mjs";
import { defineWideReplacementBenchmark } from "./wide-replacement.mjs";

function countTokens(root) {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const syntax = pending.pop();
    if (syntax.tag === "token") count += 1;
    else if (syntax.tag === "group") {
      count += syntax.close.tag === "token" ? 2 : 1;
      pending.push(...syntax.children);
    } else pending.push(...syntax.children);
  }
  return count;
}

export async function defineBenchmarkScenarios(repositoryRoot) {
  const expansionScenario = await defineExpansionBenchmark(repositoryRoot);
  const projectScaleScenario = await defineProjectScaleBenchmark();
  const wideReplacementScenario = defineWideReplacementBenchmark();
  const readerWorkloads = await defineReaderBenchmarks(repositoryRoot);
  const readerScenarios = readerWorkloads.map((workload) => ({
    id: `reader/${workload.id}`,
    description: workload.description,
    run() {
      const reader = createReader();
      let bytes = 0;
      let tokens = 0;
      let sourceId = 1;
      for (
        let repetition = 0;
        repetition < workload.repetitions;
        repetition += 1
      )
        for (const file of workload.files) {
          const result = reader.read(
            {
              sourceId: sourceId++,
              fileName: file.name,
              text: file.source,
              version: String(repetition),
            },
            { scopes: 0, variant: file.variant },
          );
          if (printLossless(result.root) !== file.source)
            throw new Error(`Reader/print mismatch for ${file.name}`);
          bytes += Buffer.byteLength(file.source);
          tokens += countTokens(result.root);
        }
      return { bytes, tokens };
    },
  }));
  const hygieneScenarios = defineScopeStoreBenchmarks().map((workload) => ({
    id: `hygiene/${workload.id}`,
    description: workload.description,
    run() {
      const store = new ScopeStore();
      workload.execute(store, workload.operations);
      return {
        operations: workload.operations,
        internedSets: store.stats.internedSets,
      };
    },
  }));
  const printerReader = createReader();
  const printerFiles = readerWorkloads[0].files.map((file, index) => ({
    source: file.source,
    root: printerReader.read(
      {
        sourceId: index + 1,
        fileName: file.name,
        text: file.source,
        version: "1",
      },
      { scopes: 0, variant: file.variant },
    ).root,
  }));
  const printerScenario = {
    id: "printer/macro-free-typescript",
    description: "Lossless printing of pre-read workspace TypeScript",
    run() {
      let bytes = 0;
      for (const file of printerFiles) {
        if (printLossless(file.root) !== file.source)
          throw new Error("Printer changed source text");
        bytes += Buffer.byteLength(file.source);
      }
      return { bytes };
    },
  };
  const generatedPrinterScenario = {
    id: "printer/generated-origin-map",
    description:
      "Print ten thousand generated tokens with copied origin regions",
    run() {
      const count = 10_000;
      const origins = new OriginStore();
      const source = origins.source(3, { start: 0, end: count * 2 });
      const copied = origins.copied(1, source);
      const syntax = Array.from({ length: count }, (_, index) =>
        createToken({
          id: index + 1,
          span: { start: index * 2, end: index * 2 + 1 },
          origin: copied,
          scopes: 0,
          kind: "identifier",
          raw: "x",
          value: "x",
          leadingTrivia:
            index === 0
              ? []
              : [
                  {
                    kind: "whitespace",
                    raw: " ",
                    span: { start: index * 2 - 1, end: index * 2 },
                  },
                ],
        }),
      );
      const printed = printExpandedFile({ syntax, origins, trace: [] });
      // One region per token, plus one for each token's leading trivia, which
      // is kept separate so a position inside a token projects back to the
      // matching offset in its source span instead of being shifted by the
      // width of the layout printed in front of it. The shape of those regions
      // is asserted in the printer's own tests; this stays a constant-time
      // check so the scenario measures printing rather than checking.
      const regions = printed.originMap.entries.length;
      if (regions !== count * 2 - 1)
        throw new Error("Generated printer lost origin regions");
      return {
        tokens: count,
        regions,
        outputBytes: Buffer.byteLength(printed.text),
      };
    },
  };
  const serviceFile = "/virtual/benchmark/main.ts";
  const artifact = (text) => ({
    text,
    originMap: { schemaVersion: 1, entries: [] },
    trace: [],
    serializedTrace: "[]\n",
  });
  const service = new VirtualLanguageServiceProject({
    compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022 },
    files: [
      { fileName: serviceFile, generated: artifact("export const value = 1;") },
    ],
  });
  let serviceVersion = 1;
  const incrementalScenario = {
    id: "host/language-service-edit",
    description: "Expanded snapshot update and semantic language-service query",
    run() {
      serviceVersion += 1;
      service.updateFile({
        fileName: serviceFile,
        generated: artifact(
          `export const value: number = ${String(serviceVersion)};`,
        ),
      });
      const diagnostics =
        service.languageService.getSemanticDiagnostics(serviceFile);
      if (diagnostics.length !== 0)
        throw new Error("Incremental host diagnostic drift");
      return { updates: 1 };
    },
  };
  const mappingScenario = {
    id: "mapping/bidirectional-origin-queries",
    description:
      "Build and query ten thousand origin-map regions in both directions",
    run() {
      const count = 10_000;
      const origins = new OriginStore();
      const entries = Array.from({ length: count }, (_, index) => {
        const origin = origins.source(2, {
          start: index * 2,
          end: index * 2 + 1,
        });
        return {
          generatedStart: index * 2,
          generatedEnd: index * 2 + 1,
          origin,
          kind: "source",
        };
      });
      const file = {
        text: "x ".repeat(count),
        originMap: { schemaVersion: 1, entries },
        trace: [],
        serializedTrace: "[]\n",
      };
      const index = createOriginQueryIndex({ file, origins });
      let hits = 0;
      for (let offset = 0; offset < count * 2; offset += 2) {
        hits += index.generatedToOriginal(offset).length;
        hits += index.originalToGenerated(2, offset).length;
      }
      if (hits !== count * 2)
        throw new Error("Origin-query benchmark lost hits");
      return { regions: count, queries: count * 2 };
    },
  };
  const cacheScenario = {
    id: "cache/content-addressed-invalidation",
    description:
      "Hash, commit, hit, and invalidate ten thousand expansion entries",
    run() {
      const count = 10_000;
      const cache = new ContentAddressedCompilerCache();
      for (let index = 0; index < count; index += 1) {
        const key = createCompilerCacheKey({
          kind: "expansion",
          readTreeHash: `tree-${String(index)}`,
          invokedMacroExportHashes: [`macro-${String(index % 100)}`],
          expansionOptionsHash: "default",
          languageVersion: "1",
        });
        cache.commit({
          key,
          value: index,
          dependencies: [`macro-${String(index % 100)}`],
        });
        cache.get(key);
      }
      const invalidated = cache.invalidateDependency("macro-0");
      return {
        entries: count,
        hits: cache.stats.hits,
        invalidated: invalidated.length,
      };
    },
  };
  const literal = (raw) =>
    createLiteralPattern(1, createTokenLiteralKey("punctuation", raw));
  const matcherPattern = createChoicePattern(
    1,
    Array.from({ length: 32 }, (_, choice) =>
      createSequencePattern(1, [
        literal("head"),
        literal("body"),
        literal(choice === 31 ? "match" : `miss-${String(choice)}`),
      ]),
    ),
  );
  const matcherProgram = compileMatcherProgram(matcherPattern, {
    rule: 1,
    inference: inferCaptureShapes(matcherPattern, {
      sourceId: 1,
      spanForOrigin: () => ({ start: 0, end: 1 }),
    }),
  });
  let matcherSyntaxId = 1;
  const matcherInput = ["head", "body", "match"].map((raw) =>
    createToken({
      id: matcherSyntaxId++,
      span: {
        start: matcherSyntaxId * 2,
        end: matcherSyntaxId * 2 + raw.length,
      },
      origin: 1,
      scopes: 0,
      kind: "punctuation",
      raw,
    }),
  );
  const matcherScenario = {
    id: "matcher/dense-choice",
    description:
      "Backtrack across dense literal alternatives in the matcher VM",
    run() {
      for (let index = 0; index < 1_000; index += 1) {
        const result = executeMatcher(matcherProgram, matcherInput, {
          consumeClass: () => undefined,
        });
        if (!result.matched) throw new Error("Dense matcher failed");
      }
      return {
        matches: 1_000,
        instructions: matcherProgram.instructions.length,
      };
    },
  };
  return [
    ...readerScenarios,
    printerScenario,
    generatedPrinterScenario,
    incrementalScenario,
    mappingScenario,
    cacheScenario,
    matcherScenario,
    expansionScenario,
    projectScaleScenario,
    wideReplacementScenario,
    ...hygieneScenarios,
  ];
}
