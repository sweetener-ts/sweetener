import { createEffect, createSignal } from "./runtime.js";

const countSignal = createSignal(1);
const labelSignal = createSignal("start");
const flagSignal = createSignal(false);

export const seen: string[] = [];

createEffect(() => {
  seen.push(`${labelSignal.get()}:${countSignal.get()}`);
});

countSignal.set(5);
countSignal.set(
            countSignal.get() + 2
          );
countSignal.set(
            countSignal.get() * 3
          );
countSignal.set(
            countSignal.get() - 1
          );
countSignal.set(
            countSignal.get() >> 1
          );
(flagSignal.get() ||
            flagSignal.set(true));
labelSignal.set("done");

// An assignment is an expression, so it has the value it wrote.
export const assigned: number = (countSignal.set(42));

export const observed: readonly string[] = [...seen];
export const settled: readonly [number, boolean] = [countSignal.get(), flagSignal.get()];