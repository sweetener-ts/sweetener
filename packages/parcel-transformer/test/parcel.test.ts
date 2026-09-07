import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Parcel } from "@parcel/core";
import { afterEach, expect, test } from "vitest";

const temporaryProjects = new Set<string>();
afterEach(() => {
  for (const directory of temporaryProjects)
    rmSync(directory, { recursive: true, force: true });
  temporaryProjects.clear();
});

const createProject = (): string => {
  const temporaryRoot = resolve("_tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const root = realpathSync(mkdtempSync(join(temporaryRoot, "sweet-parcel-")));
  temporaryProjects.add(root);
  const scope = join(root, "node_modules", "@sweetener");
  mkdirSync(scope, { recursive: true });
  symlinkSync(
    resolve("packages/parcel-transformer"),
    join(scope, "parcel-transformer"),
    "dir",
  );
  const parcelScope = join(root, "node_modules", "@parcel");
  mkdirSync(parcelScope, { recursive: true });
  symlinkSync(
    resolve("packages/parcel-transformer/node_modules/@parcel/config-default"),
    join(parcelScope, "config-default"),
    "dir",
  );
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(root, "main.sts"),
    `import { twice } from "./macros.sts" for syntax;\nconsole.log(twice(21));\n`,
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["main.sts", "macros.sts"],
    }),
  );
  writeFileSync(
    join(root, ".parcelrc"),
    JSON.stringify({
      extends: "@parcel/config-default",
      transformers: {
        "*.sts": ["@sweetener/parcel-transformer", "..."],
      },
    }),
  );
  return root;
};

const buildProject = (
  root: string,
  output: string,
): Promise<{ type: string }> =>
  new Parcel({
    entries: join(root, "main.sts"),
    defaultConfig: "@parcel/config-default",
    config: join(root, ".parcelrc"),
    mode: "production",
    defaultTargetOptions: {
      distDir: output,
      sourceMaps: true,
      shouldOptimize: false,
    },
  }).run();

test("Parcel builds Sweetener with its native transformer", async () => {
  const root = createProject();
  const output = join(root, "dist");
  const event = await buildProject(root, output);
  expect(event.type).toBe("buildSuccess");
  const javascript = readdirSync(output).find((name) => name.endsWith(".js"));
  expect(javascript).toBeDefined();
  const code = readFileSync(join(output, javascript!), "utf8");
  expect(code).toContain("21");
  expect(code).not.toContain("twice(");
});

// `@parcel/logger` ships no types, and its diagnostics are the only place these
// warnings surface: Parcel reports them through the logger rather than in the
// build event, so a build can "succeed" while telling the user its cache is
// useless.
interface ParcelLogEvent {
  readonly level: string;
  readonly diagnostics?: readonly { readonly message: string }[] | undefined;
}
interface ParcelLogger {
  onLog(callback: (event: ParcelLogEvent) => void): { dispose(): void };
}

// Parcel analyses an ES module plugin's whole module graph, gives up when it
// reaches the TypeScript compiler's dynamic `require` calls, and then throws
// away its cache on every startup. A CommonJS entry is loaded through Parcel's
// own `require` instead and is never analysed, so nothing is warned about and
// nothing is invalidated. Reverting the entry to an ES module brings both
// warnings back, which is what this test exists to catch.
test("a Parcel build with the transformer installed warns about nothing", async () => {
  const require = createRequire(import.meta.url);
  const logger = (require("@parcel/logger") as { default: ParcelLogger })
    .default;
  const warnings: string[] = [];
  const subscription = logger.onLog((event) => {
    if (event.level !== "warn" && event.level !== "error") return;
    for (const diagnostic of event.diagnostics ?? [])
      warnings.push(diagnostic.message);
  });
  try {
    const root = createProject();
    const event = await buildProject(root, join(root, "dist"));
    expect(event.type).toBe("buildSuccess");
  } finally {
    subscription.dispose();
  }
  expect(warnings).toEqual([]);
});
