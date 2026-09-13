const value = "outer value";
const matched = "outer matched";

type Option<T> = { readonly tag: "None" } | { readonly tag: "Some"; value: T };
const None = <T>(): Option<T> => ({ tag: "None" });
const Some = <T>(value_1: T): Option<T> => ({ tag: "Some", value: value_1 });

export const hygieneResult = [
  value,
  matched,
  {
    value: Some(3),
    run() {
      if (this.value.tag === "Some") {
        const { value: value_1 } = this.value;
        return value_1 + 1;
      }
      if (this.value.tag === "None") return 0;
      const unmatched: never = this.value;
      throw new globalThis.Error(
        "No match for " + globalThis.JSON.stringify(unmatched),
      );
    },
  }.run(),
];

void None;
