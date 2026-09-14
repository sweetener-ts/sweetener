import { matchUnhandled } from "./runtime.js";

// `matched` is the name the macro gives its subject temporary.
const matched = "call-site binding";

export const kept: string = matched;

export const chosen: string = ((matched_1) => { if (((matched_1) === "call-site binding")) {
        ;
          return matched;
      }
      return "other";
    })(matched);