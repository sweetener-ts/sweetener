import { matchUnhandled } from "./runtime.js";

export type Event =
  | { readonly type: "click"; readonly x: number; readonly y: number }
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "scroll"; readonly delta: readonly number[] };

export function describe(event: Event): string {
  return ((matched) => {if (((((typeof matched) === "object") && (matched !== null))
        && (((matched)["type"]) === "click"))) {
        ;
        const x = (matched)["x"];
        const y = (matched)["y"];
          if ((x > 0)) { return `click ${x},${y}`; }
      }if (((((typeof matched) === "object") && (matched !== null))
        && (((matched)["type"]) === "click"))) {
        ;
          return "click offscreen";
      }if ((((((typeof matched) === "object") && (matched !== null))
        && (((matched)["type"]) === "key"))
        && (((matched)["key"]) === "Escape"))) {
        ;
        ;
          return "escape";
      }if (((((typeof matched) === "object") && (matched !== null))
        && (((matched)["type"]) === "key"))) {
        ;
        const key = (matched)["key"];
          return `key ${key}`;
      }if ((((((typeof matched) === "object") && (matched !== null))
        && (((matched)["type"]) === "scroll"))
        && (((globalThis.Array.isArray((matched)["delta"])
      && (((matched)["delta"]).length === 2))&& true)&& true))) {
        ;
        const first = ((matched)["delta"])[0];const second = ((matched)["delta"])[1];
          return `scroll ${first}/${second}`;
      }
      return "unknown";
    })(event);
}

// No wildcard: every member of the union is answered, and the compiler is what
// says so. Adding a member to Event makes this a type error.
export function name(event: Event): string {
  return ((matched_1) => {if (((((typeof matched_1) === "object") && (matched_1 !== null))
        && (((matched_1)["type"]) === "click"))) {
        ;
          return "click";
      }if (((((typeof matched_1) === "object") && (matched_1 !== null))
        && (((matched_1)["type"]) === "key"))) {
        ;
          return "key";
      }if (((((typeof matched_1) === "object") && (matched_1 !== null))
        && (((matched_1)["type"]) === "scroll"))) {
        ;
          return "scroll";
      }
      return matchUnhandled(matched_1);
    })(event);
}

const samples: readonly Event[] = [
  { type: "click", x: 3, y: 4 },
  { type: "click", x: 0, y: 0 },
  { type: "key", key: "Escape" },
  { type: "key", key: "a" },
  { type: "scroll", delta: [1, 2] },
];

export const described: readonly string[] = samples.map(describe);
export const named: readonly string[] = samples.map(name);