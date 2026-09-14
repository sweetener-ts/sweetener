import { createEffect, createSignal } from "./runtime.js";

const countSignal = createSignal(1);

// The storage the macro derives is `countSignal`; this one must stay separate.
const other = countSignal.get() + 1;

export const observed: readonly number[] = [countSignal.get(), other];