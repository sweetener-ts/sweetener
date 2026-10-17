import type {
  CaptureId,
  CaptureSlotId,
  ProgramCounter,
  RuleId,
} from "@sweetener/shared";
import type { PatternNode } from "./ast.js";
import { captureShapeDepth } from "./capture-shape.js";
import type { CaptureShapeInferenceResult } from "./shape-inference.js";
import type {
  CaptureSlot,
  MatcherInstruction,
  MatcherProgram,
} from "./matcher-program.js";

export interface CompileMatcherProgramOptions {
  readonly rule: RuleId;
  readonly inference: CaptureShapeInferenceResult;
}

type MutableInstruction =
  | MatcherInstruction
  | {
      origin: MatcherInstruction["origin"];
      op: "repeat-commit";
      repetition: Extract<
        MatcherInstruction,
        { op: "repeat-commit" }
      >["repetition"];
      loop: ProgramCounter | undefined;
      exit: ProgramCounter;
    };

function freezeInstruction(
  instruction: MutableInstruction,
): MatcherInstruction {
  if (instruction.op === "repeat-commit" && instruction.loop === undefined) {
    throw new Error("Unpatched repeat commit");
  }
  return Object.freeze({ ...instruction }) as MatcherInstruction;
}

export function compileMatcherProgram(
  pattern: PatternNode,
  options: CompileMatcherProgramOptions,
): MatcherProgram {
  if (options.inference.diagnostics.length > 0) {
    throw new RangeError("Cannot compile a pattern with shape diagnostics");
  }

  const captureSlots: CaptureSlot[] = options.inference.bindings.map(
    (binding, index) =>
      Object.freeze({
        slot: index as CaptureSlotId,
        capture: binding.capture,
        name: binding.name,
        depth: captureShapeDepth(binding.shape),
      }),
  );
  const slotByCapture = new Map<CaptureId, CaptureSlotId>(
    captureSlots.map((slot) => [slot.capture, slot.slot]),
  );
  const instructions: MutableInstruction[] = [];
  const emit = (instruction: MutableInstruction): ProgramCounter => {
    const pc = instructions.length as ProgramCounter;
    instructions.push(instruction);
    return pc;
  };
  const accept = emit({ op: "accept", origin: pattern.origin });

  const slotsIn = (root: PatternNode): readonly CaptureSlotId[] => {
    const found = new Set<CaptureSlotId>();
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      switch (current.kind) {
        case "capture": {
          const slot = slotByCapture.get(current.capture);
          if (slot !== undefined) found.add(slot);
          break;
        }
        case "sequence":
          pending.push(...current.elements);
          break;
        case "choice":
          pending.push(...current.alternatives);
          break;
        case "group":
        case "optional":
          pending.push(current.body);
          break;
        case "repeat":
          pending.push(current.body);
          if (current.separator !== undefined) pending.push(current.separator);
          break;
        default:
          break;
      }
    }
    return Object.freeze([...found].sort((left, right) => left - right));
  };

  type Assignment = (entry: ProgramCounter) => void;
  type Task = () => void;
  const tasks: Task[] = [];
  let entry: ProgramCounter | undefined;

  const schedule = (
    node: PatternNode,
    continuation: ProgramCounter,
    assign: Assignment,
  ): void => {
    tasks.push(() => {
      switch (node.kind) {
        case "literal":
          assign(
            emit({
              op: "literal",
              origin: node.origin,
              literal: node.literal,
              joined: node.joined,
              next: continuation,
            }),
          );
          break;
        case "capture":
          assign(
            emit({
              op: "class",
              origin: node.origin,
              classId: node.classId,
              capture: slotByCapture.get(node.capture),
              next: continuation,
            }),
          );
          break;
        case "class-call":
          assign(
            emit({
              op: "class",
              origin: node.origin,
              classId: node.classId,
              capture: undefined,
              next: continuation,
            }),
          );
          break;
        case "lookahead":
          assign(
            emit({
              op: "lookahead",
              origin: node.origin,
              predicate: node.predicate,
              next: continuation,
            }),
          );
          break;
        case "sequence": {
          let index = node.elements.length - 1;
          let next = continuation;
          const advance = (): void => {
            if (index < 0) {
              assign(next);
              return;
            }
            const child = node.elements[index]!;
            index -= 1;
            schedule(child, next, (childEntry) => {
              next = childEntry;
              tasks.push(advance);
            });
          };
          tasks.push(advance);
          break;
        }
        case "choice": {
          const entries: ProgramCounter[] = [];
          let index = 0;
          const advance = (): void => {
            if (index >= node.alternatives.length) {
              let choiceEntry = entries.at(-1)!;
              for (let branch = entries.length - 2; branch >= 0; branch -= 1) {
                choiceEntry = emit({
                  op: "split",
                  origin: node.origin,
                  first: entries[branch]!,
                  second: choiceEntry,
                });
              }
              assign(choiceEntry);
              return;
            }
            const alternative = node.alternatives[index]!;
            index += 1;
            schedule(alternative, continuation, (alternativeEntry) => {
              entries.push(alternativeEntry);
              tasks.push(advance);
            });
          };
          tasks.push(advance);
          break;
        }
        case "group": {
          const groupAccept = emit({
            op: "group-accept",
            origin: node.origin,
          });
          schedule(node.body, groupAccept, (body) => {
            assign(
              emit({
                op: "group",
                origin: node.origin,
                delimiter: node.delimiter,
                body,
                next: continuation,
              }),
            );
          });
          break;
        }
        case "optional": {
          const commit = emit({
            op: "repeat-commit",
            origin: node.origin,
            repetition: node.repetition,
            loop: undefined,
            exit: continuation,
          });
          schedule(node.body, commit, (body) => {
            const instruction = instructions[commit];
            if (instruction?.op !== "repeat-commit")
              throw new Error("Optional commit patch target changed");
            instructions[commit] = { ...instruction, loop: body };
            assign(
              emit({
                op: "repeat-enter",
                origin: node.origin,
                repetition: node.repetition,
                cardinalityGroup: node.cardinalityGroup,
                body,
                separator: undefined,
                exit: continuation,
                minimum: 0,
                maximum: 1,
                captures: slotsIn(node.body),
              }),
            );
          });
          break;
        }
        case "repeat": {
          const commit = emit({
            op: "repeat-commit",
            origin: node.origin,
            repetition: node.repetition,
            loop: undefined,
            exit: continuation,
          });
          const finish = (
            body: ProgramCounter,
            separator: ProgramCounter | undefined,
          ): void => {
            const instruction = instructions[commit];
            if (instruction?.op !== "repeat-commit")
              throw new Error("Repeat commit patch target changed");
            instructions[commit] = {
              ...instruction,
              loop: separator ?? body,
            };
            assign(
              emit({
                op: "repeat-enter",
                origin: node.origin,
                repetition: node.repetition,
                cardinalityGroup: node.cardinalityGroup,
                body,
                separator,
                exit: continuation,
                minimum: node.minimum,
                maximum: node.maximum,
                captures: slotsIn(node.body),
              }),
            );
          };
          schedule(node.body, commit, (body) => {
            if (node.separator === undefined) finish(body, undefined);
            else
              schedule(node.separator, body, (separator) =>
                finish(body, separator),
              );
          });
          break;
        }
      }
    });
  };

  schedule(pattern, accept, (value) => {
    entry = value;
  });
  while (tasks.length > 0) tasks.pop()!();
  if (entry === undefined)
    throw new Error("Matcher compilation did not finish");

  return Object.freeze({
    rule: options.rule,
    entry,
    instructions: Object.freeze(instructions.map(freezeInstruction)),
    captureSlots: Object.freeze(captureSlots),
  });
}

export function serializeMatcherProgram(program: MatcherProgram): string {
  return `${JSON.stringify(program)}\n`;
}
