import module from "node:module";

/**
 * The first Node release that deprecates `module.register` (DEP0205) in favour
 * of `module.registerHooks`, printing a warning to every program preloaded
 * through it.
 *
 * Earlier releases in the supported range (24 and 25) keep `module.register`:
 * there it is the settled API and warns about nothing, while `registerHooks`
 * is still a release candidate.
 */
const registerHooksFrom = 26;

const major = Number(process.versions.node.split(".")[0]);

if (major >= registerHooksFrom) {
  // Imported only here: under `module.register` the hooks run on a thread of
  // their own, and loading the compiler on this one as well would be wasted.
  const { resolve, load } = await import("./hooks.js");
  module.registerHooks({ resolve, load });
} else {
  module.register(new URL("./hooks.js", import.meta.url));
}
