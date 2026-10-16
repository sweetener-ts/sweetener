import {
  createBinding,
  createPhase,
} from "../packages/hygiene/dist/src/index.js";
import { ExpansionEnvironmentStore } from "../packages/expansion/dist/src/index.js";

/** How many macros, and how many operators, one environment registers. */
const MACROS = 5_000;

/**
 * One macro environment extended by thousands of macros and operators, one at
 * a time, as a definition context registers a module's definitions, and then
 * asked for each of them.
 *
 * A module defines a handful of macros, so an environment that copied itself
 * for every one it registered would cost the same as one that did not. It
 * would cost the square of a generated module of thousands: 10,000 macros and
 * operators took 4.9 s to register that way.
 */
export function defineMacroEnvironmentBenchmark() {
  const phase = createPhase(1);
  const bindings = Array.from({ length: MACROS }, (_, index) =>
    createBinding({
      id: index + 1,
      spelling: `macro${String(index)}`,
      scopes: 0,
      phase,
      space: "syntax-expr",
      declaration: index + 1,
      kind: "macro",
    }),
  );
  const operators = Array.from({ length: MACROS }, (_, index) => ({
    binding: MACROS + index + 1,
    spelling: `+${String(index)}`,
    phase,
    category: "expr",
    fixity: "infix",
    associativity: "left",
    precedence: 10,
    origin: index + 1,
  }));
  return {
    id: "expansion/macro-environment",
    description: `Register ${String(MACROS)} macros and ${String(MACROS)} operators in one environment and look each up`,
    run() {
      const store = new ExpansionEnvironmentStore();
      let environment = store.createRoot();
      for (let index = 0; index < MACROS; index += 1) {
        environment = store.extendBinding(environment, bindings[index]);
        environment = store.extendOperator(environment, operators[index]);
      }
      let found = 0;
      for (let index = 0; index < MACROS; index += 1) {
        found += store.lookupBindings(environment, {
          spelling: `macro${String(index)}`,
          phase,
          category: "expr",
        }).length;
        found += store.lookupOperators(environment, {
          spelling: `+${String(index)}`,
          phase,
          category: "expr",
        }).length;
      }
      if (found !== 2 * MACROS)
        throw new Error("Macro-environment benchmark lost a definition");
      return { entries: 2 * MACROS };
    },
  };
}
