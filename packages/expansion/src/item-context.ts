import type { Binding, Phase } from "@sweetener/hygiene";
import {
  StopSet,
  type ConsumerFailure,
  type SyntaxConsumer,
} from "@sweetener/enforestation";
import {
  neverCancelled,
  type CancellationToken,
  type Diagnostic,
  type ResourceTracker,
} from "@sweetener/shared";
import {
  createSyntaxSequence,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCursor,
  type SyntaxSequence,
} from "@sweetener/syntax";
import {
  processDefinitionContext,
  type DefinitionContextItem,
  type DefinitionContextStep,
  type RegisteredDefinition,
  type ValidatePreparedDefinition,
} from "./definition-context.js";
import type {
  ExpansionEnvironment,
  ExpansionEnvironmentStore,
} from "./environment.js";

export interface ClassifyItemRequest {
  readonly syntax: ProtectedSyntax;
  readonly environment: ExpansionEnvironment;
  readonly index: number;
}

export type ClassifyDefinitionContextItem = (
  request: ClassifyItemRequest,
) => DefinitionContextItem;

export interface ProcessItemContextOptions {
  readonly store: ExpansionEnvironmentStore;
  readonly environment: ExpansionEnvironment;
  readonly cursor: SyntaxCursor;
  readonly consumer: SyntaxConsumer;
  readonly phase: Phase;
  readonly tracker: ResourceTracker;
  readonly cancellation?: CancellationToken | undefined;
  readonly classify: ClassifyDefinitionContextItem;
  readonly validate: ValidatePreparedDefinition;
}

export interface ItemContextState {
  readonly environment: ExpansionEnvironment;
  readonly cursor: SyntaxCursor;
  readonly items: readonly ProtectedSyntax[];
  readonly emitted: SyntaxSequence;
  readonly runtimeBindings: readonly Binding[];
  readonly definitions: readonly RegisteredDefinition[];
  readonly diagnostics: readonly Diagnostic[];
  readonly steps: readonly DefinitionContextStep[];
}

export interface ProcessItemContextSuccess extends ItemContextState {
  readonly matched: true;
}

export interface ProcessItemContextFailure extends ItemContextState {
  readonly matched: false;
  readonly failure: ConsumerFailure;
}

export type ProcessItemContextResult =
  ProcessItemContextSuccess | ProcessItemContextFailure;

export function processItemContext(
  options: ProcessItemContextOptions,
): ProcessItemContextResult {
  const cancellation = options.cancellation ?? neverCancelled;
  const cursor = options.cursor.fork();
  let environment = options.environment;
  const items: ProtectedSyntax[] = [];
  const emitted: Syntax[] = [];
  const runtimeBindings: Binding[] = [];
  const definitions: RegisteredDefinition[] = [];
  const diagnostics: Diagnostic[] = [];
  const steps: DefinitionContextStep[] = [];

  const state = (): ItemContextState => ({
    environment,
    cursor,
    items: Object.freeze([...items]),
    emitted: createSyntaxSequence(emitted),
    runtimeBindings: Object.freeze([...runtimeBindings]),
    definitions: Object.freeze([...definitions]),
    diagnostics: Object.freeze([...diagnostics]),
    steps: Object.freeze([...steps]),
  });

  while (!cursor.atEnd) {
    cancellation.throwIfCancellationRequested();
    const working = cursor.fork();
    const attempted = options.consumer.consume(
      working,
      Object.freeze({
        category: "item" as const,
        phase: options.phase,
        environmentEpoch: environment.epoch,
        stopSet: StopSet.empty,
        tracker: options.tracker,
        cancellation,
        // Module items stand outside every function, so never in a generator.
        allowYield: false,
      }),
    );
    if (!attempted.matched) {
      return Object.freeze({
        matched: false,
        ...state(),
        failure: attempted.failure,
      });
    }
    if (
      attempted.cursor.index <= cursor.index ||
      attempted.syntax.category !== "item"
    ) {
      throw new TypeError("Item consumer returned an invalid extent");
    }
    cursor.advance(attempted.cursor.index - cursor.index);
    items.push(attempted.syntax);
    const classified = options.classify({
      syntax: attempted.syntax,
      environment,
      index: items.length - 1,
    });
    const processed = processDefinitionContext({
      store: options.store,
      environment,
      items: Object.freeze([classified]),
      validate: options.validate,
    });
    environment = processed.environment;
    emitted.push(...processed.emitted);
    runtimeBindings.push(...processed.runtimeBindings);
    definitions.push(...processed.definitions);
    diagnostics.push(...processed.diagnostics);
    for (const step of processed.steps) {
      steps.push(Object.freeze({ ...step, index: steps.length }));
    }
  }
  return Object.freeze({ matched: true, ...state() });
}
