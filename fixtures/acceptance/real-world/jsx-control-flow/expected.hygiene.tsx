
import { Fragment, h } from "./jsx-runtime.js";

void h;
void Fragment;

// The block names its own binders; these must survive outside it.
const item = "call-site item";
const index = 7;

export const kept: readonly [string, number] = [item, index];

export const mapped = (
  <ul>
    {([10, 20]).map((item, index) =>
      <li>{index}: {item}</li>
    )}
  </ul>
);