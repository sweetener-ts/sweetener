import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrattExpressionConsumer,
  StopSet,
} from "@sweetener/enforestation";
import { createPhase } from "@sweetener/hygiene";
import {
  createSyntaxClassConsumer,
  type CaptureValue,
} from "@sweetener/pattern";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  neverCancelled,
  ResourceTracker,
  type EnvironmentEpoch,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import { createSyntaxCursor, OriginStore } from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  compileParsedSyntaxClasses,
  parseMacroDefinitions,
} from "../src/index.js";

const sourceId = 71 as SourceId;
const scopes = 0 as ScopeSetId;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const fixtureRoot = path.join(
  repositoryRoot,
  "fixtures/phase-02/structural-examples",
);

interface StructuralCase {
  readonly className: string;
  readonly source: string;
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

interface Placeholder {
  readonly className: string;
  readonly behavior: string;
  readonly replacementTask: string;
  readonly replacement: string;
}

function captureTexts(value: CaptureValue): readonly string[] {
  const values: string[] = [];
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.kind === "leaf") {
      values.push(printLosslessSequence(current.syntax).trim());
    } else {
      for (let index = current.elements.length - 1; index >= 0; index -= 1) {
        pending.push(current.elements[index]!);
      }
    }
  }
  return Object.freeze(values);
}

describe("Phase 2 structural playground ports", () => {
  it("matches Bind, BindAll, protocol, ADT, and mixfix segment structures", async () => {
    const definitionSource = await readFile(
      path.join(fixtureRoot, "declarative.sts"),
      "utf8",
    );
    const cases = JSON.parse(
      await readFile(path.join(fixtureRoot, "cases.json"), "utf8"),
    ) as { readonly cases: readonly StructuralCase[] };
    const origins = new OriginStore();
    const read = readSyntax(definitionSource, {
      sourceId,
      scopes,
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    expect(parsed.diagnostics).toEqual([]);
    const compiled = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin: (origin) =>
        read.origins.selectPrimarySource(origin)?.span ?? {
          start: 0,
          end: 0,
        },
    });
    expect(compiled.diagnostics).toEqual([]);

    const classIds = new Map(
      parsed.classBindings.map((binding) => [binding.name, binding.classId]),
    );
    const token = classIds.get("token");
    const tt = classIds.get("tt");
    const ident = classIds.get("ident");
    const binding = classIds.get("binding");
    const expr = classIds.get("expr");
    const type = classIds.get("type");
    if (
      token === undefined ||
      tt === undefined ||
      ident === undefined ||
      binding === undefined ||
      expr === undefined ||
      type === undefined
    ) {
      throw new Error("missing fixed class bindings");
    }
    const externalIds = new Set([binding, type]);
    const expressionSyntaxIds = createIdAllocator<SyntaxId>(100_000);
    const expressionConsumer = createPrattExpressionConsumer({
      origins,
      allocateSyntaxId: () => expressionSyntaxIds.allocate(),
    });
    const consumer = createSyntaxClassConsumer(compiled.registry, {
      builtins: { token, tt, ident },
      externalConsumer: (classId, cursor) => {
        if (classId === expr) {
          const expression = expressionConsumer.consume(cursor, {
            category: "expr",
            phase: createPhase(0),
            environmentEpoch: 0 as EnvironmentEpoch,
            stopSet: StopSet.empty,
            tracker: new ResourceTracker(createResourceBudget()),
            cancellation: neverCancelled,
            allowYield: false,
            allowAwait: false,
          });
          if (!expression.matched) return undefined;
          return {
            cursor: expression.cursor,
            syntax: Object.freeze([expression.syntax]),
            origin: expression.syntax.origin,
          };
        }
        if (!externalIds.has(classId)) return undefined;
        const syntax = cursor.peek();
        if (
          syntax === undefined ||
          (classId === binding &&
            (syntax.tag !== "token" || syntax.kind !== "identifier"))
        ) {
          return undefined;
        }
        cursor.advance();
        return {
          cursor,
          syntax: Object.freeze([syntax]),
          origin: syntax.origin,
        };
      },
    });

    for (const fixture of cases.cases) {
      const classId = classIds.get(fixture.className);
      const definition = parsed.definitions.find(
        (candidate) =>
          candidate.kind === "syntax-class" &&
          candidate.name === fixture.className,
      );
      if (classId === undefined || definition?.kind !== "syntax-class") {
        throw new Error(`missing class ${fixture.className}`);
      }
      const input = readSyntax(fixture.source, {
        sourceId,
        scopes,
        originStore: origins,
      });
      expect(input.diagnostics, fixture.className).toEqual([]);
      const syntax = input.root.children.filter(
        (item) => item.tag !== "token" || item.kind !== "end-of-file",
      );
      const matched = consumer(classId, createSyntaxCursor(syntax));
      expect(matched, fixture.className).toBeDefined();
      expect(matched?.cursor.atEnd, fixture.className).toBe(true);
      for (const [fieldName, expected] of Object.entries(fixture.fields)) {
        const field = definition.fields.find(
          (candidate) => candidate.name === fieldName,
        );
        if (field === undefined) throw new Error(`missing field ${fieldName}`);
        const value = matched?.fields?.get(field.capture);
        expect(value, `${fixture.className}.${fieldName}`).toBeDefined();
        if (value !== undefined) {
          expect(
            captureTexts(value),
            `${fixture.className}.${fieldName}`,
          ).toEqual(expected);
        }
      }
    }
  });

  it("records each placeholder and its Phase 4 replacement task", async () => {
    const ledger = JSON.parse(
      await readFile(path.join(fixtureRoot, "placeholders.json"), "utf8"),
    ) as { readonly placeholders: readonly Placeholder[] };
    expect(
      ledger.placeholders.map((placeholder) => [
        placeholder.className,
        placeholder.replacementTask,
      ]),
    ).toEqual([
      ["binding", "ENF-005"],
      ["type", "ENF-006"],
    ]);
    for (const placeholder of ledger.placeholders) {
      expect(placeholder.behavior.length).toBeGreaterThan(0);
      expect(placeholder.replacement.length).toBeGreaterThan(0);
    }
  });
});
