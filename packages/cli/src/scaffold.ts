import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The files a project needs before a macro will run in it.
 *
 * Finding this out otherwise means reading a sample project and working
 * backwards from its `package.json` and `tsconfig.json` to what is required,
 * which is not a thing anyone should have to derive.
 */
export interface ScaffoldedProject {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly notes: readonly string[];
}

const macros = `// A macro is declared with \`syntax\`, and exported like anything else.
// \`:expr\` is where it may be written: in expression position.
export syntax twice:expr {
  // A rule is a pattern and the syntax it expands to. \`$value:expr\` captures
  // one expression under the name \`value\`.
  rule { twice($value:expr) } => { [$value, $value] }
}

// Macros can introduce bindings without capturing the ones around them.
// \`total\` here cannot collide with a \`total\` at the call site.
export syntax sum:expr {
  rule { sum($values:expr) } => {
    (($values).reduce((total: number, next: number) => total + next, 0))
  }
}
`;

const main = `// Macros are imported \`for syntax\`, which says they run at compile time.
// The import itself does not survive into the emitted TypeScript.
import { sum, twice } from "./macros.sts" for syntax;

export const pair: readonly number[] = twice(21);
export const total: number = sum([1, 2, 3]);

// A binding of the same name as one a macro introduces is left alone.
const values = [total];
export const doubled: readonly (readonly number[])[] = values.map((value) =>
  twice(value),
);
`;

function packageManifest(name: string, cliSpecifier: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        build: "sweetener build -p tsconfig.json",
        check: "sweetener check -p tsconfig.json",
        watch: "sweetener watch -p tsconfig.json",
      },
      dependencies: {
        "@sweetener/cli": cliSpecifier,
        typescript: "npm:@typescript/typescript6@6.0.2",
      },
    },
    null,
    2,
  )}\n`;
}

const tsconfig = `${JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      declaration: true,
      outDir: "dist",
      rootDir: "src",
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    sweet: {
      languageVersion: "1",
      macroExtensions: [".sts"],
    },
    files: ["src/macros.sts", "src/main.sts"],
  },
  null,
  2,
)}\n`;

/**
 * Where to point a new project's dependency on the command line.
 *
 * Nothing is published yet, so a project outside this repository has to reach
 * the packages through the checkout it is being scaffolded from. Once these
 * are on a registry the version is the right answer and the path is not.
 */
function cliSpecifier(): {
  readonly specifier: string;
  readonly note: string | undefined;
} {
  // Walked up to the package rather than counted, because this file sits at a
  // different depth built than it does in source, and counting gets one of
  // them wrong.
  let packaged = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(packaged, "package.json"))) {
    const parent = dirname(packaged);
    if (parent === packaged)
      return { specifier: "^0.1.0-alpha.0", note: undefined };
    packaged = parent;
  }
  // A checkout, rather than an install from a registry, is the only place a
  // link can point at.
  if (!existsSync(resolve(packaged, "..", "..", "pnpm-workspace.yaml")))
    return { specifier: "^0.1.0-alpha.0", note: undefined };
  // Absolute, because a relative one is read from wherever the project ends up
  // and quietly resolves somewhere else — a scaffold under a symlinked
  // directory links to nothing at all.
  return {
    specifier: `link:${packaged}`,
    note: `@sweetener/cli is not published yet, so this project links to the checkout at ${packaged}. Build that checkout once (pnpm build) before installing here, and expect the link to break if it moves.`,
  };
}

export function scaffoldProject(options: {
  readonly directory: string;
  readonly name?: string | undefined;
}): ScaffoldedProject {
  const directory = resolve(options.directory);
  const name =
    options.name ?? (directory.split(/[/\\]/u).at(-1) || "sweet-app");
  const cli = cliSpecifier();
  const files = [
    { path: "package.json", text: packageManifest(name, cli.specifier) },
    { path: "tsconfig.json", text: tsconfig },
    { path: join("src", "macros.sts"), text: macros },
    { path: join("src", "main.sts"), text: main },
  ];
  return Object.freeze({
    files: Object.freeze(files),
    notes: Object.freeze([
      ...(cli.note === undefined ? [] : [cli.note]),
      "Install dependencies, then `npm run check` to type-check and `npm run build` to emit into dist/.",
      "Macros live in .sts files and are imported `for syntax`. Editing src/macros.sts changes the language src/main.sts is written in.",
    ]),
  });
}

/** Writes a scaffold, refusing to overwrite anything already there. */
export function writeScaffold(project: ScaffoldedProject, directory: string) {
  const root = resolve(directory);
  const existing = project.files
    .map(({ path }) => path)
    .filter((path) => existsSync(join(root, path)));
  if (existing.length > 0)
    throw new Error(
      `Refusing to overwrite ${existing.join(", ")} in ${root}. Move or delete them, or scaffold into a different directory.`,
    );
  for (const { path, text } of project.files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  return Object.freeze(project.files.map(({ path }) => path));
}

/** How a host project compiles, and so which integration belongs in it. */
export interface DetectedHost {
  readonly name: string;
  readonly integration: string;
  readonly wiring: readonly string[];
}

const viteWiring = (importPath: string, plugins: string) => [
  `Add the plugin to your config:`,
  ``,
  `  import sweetener from "${importPath}";`,
  `  import { resolve } from "node:path";`,
  ``,
  `  ${plugins}`,
  `    ...sweetener({`,
  `      configFile: resolve(import.meta.dirname, "sweetener.json"),`,
  `    }),`,
  `  ]`,
];

/**
 * Which integration a project needs, read from what it already depends on.
 *
 * Every one of these is how one of the projects under `examples/` is wired, or
 * — for Rsbuild and Farm, which have an entry point but no example — how
 * `docs/integrations.md` says to wire it. Working it out otherwise means
 * finding the example that matches your host and reading its config, which is
 * only discoverable if you know to look.
 */
export function detectHost(options: {
  readonly manifest?:
    | {
        readonly dependencies?: Readonly<Record<string, string>> | undefined;
        readonly devDependencies?: Readonly<Record<string, string>> | undefined;
      }
    | undefined;
  readonly directory: string;
}): DetectedHost | undefined {
  const dependencies = {
    ...options.manifest?.dependencies,
    ...options.manifest?.devDependencies,
  };
  const has = (name: string) => Object.hasOwn(dependencies, name);
  // A runtime is recognised by its own config, because a project built for one
  // may carry no package.json to declare anything in.
  const hasFile = (...names: readonly string[]) =>
    names.some((name) => existsSync(join(options.directory, name)));

  if (hasFile("deno.json", "deno.jsonc"))
    return {
      name: "Deno",
      integration: "@sweetener/deno",
      wiring: [
        `Preload the loader hook, which expands sources as they are imported:`,
        ``,
        `  deno run --import @sweetener/deno/register app.ts`,
        ``,
        `Then import a .sts file directly; there is no build step. Point`,
        `SWEETENER_CONFIG at this project's sweetener.json if it is not beside`,
        `the sources.`,
        ``,
        `Deno builds the module graph for \`deno test\` and \`deno check\` before`,
        `loader hooks apply, so those two reject a .sts import. For them,`,
        `expand ahead of time with emitStandalone from @sweetener/cli and`,
        `point them at the output.`,
      ],
    };
  if (has("bun") || hasFile("bunfig.toml"))
    return {
      name: "Bun",
      integration: "@sweetener/unplugin",
      wiring: [
        `Add the plugin to your Bun build:`,
        ``,
        `  import sweetener from "@sweetener/unplugin/bun";`,
        `  import { resolve } from "node:path";`,
        ``,
        `  await Bun.build({`,
        `    entrypoints: ["src/index.ts"],`,
        `    plugins: [`,
        `      sweetener({`,
        `        configFile: resolve(import.meta.dir, "sweetener.json"),`,
        `      }),`,
        `    ],`,
        `  });`,
        ``,
        `To import .sts directly under \`bun run\`, register the same plugin from`,
        `a preload named in bunfig.toml:`,
        ``,
        `  preload = ["./sweetener.preload.ts"]`,
        ``,
        `  // sweetener.preload.ts`,
        `  Bun.plugin(sweetener({ configFile: resolve(import.meta.dir, "sweetener.json") }));`,
      ],
    };

  if (has("next"))
    return {
      name: "Next.js",
      integration: "@sweetener/webpack-loader",
      wiring: [
        `Add a rule for .sts files in next.config, loading them as TypeScript:`,
        ``,
        `  turbopack: {`,
        `    rules: {`,
        `      "*.sts": {`,
        `        loaders: [`,
        `          {`,
        `            loader: require.resolve("@sweetener/webpack-loader"),`,
        `            options: { configFile: resolve(here, "sweetener.json") },`,
        `          },`,
        `        ],`,
        `        as: "*.ts",`,
        `      },`,
        `    },`,
        `  }`,
      ],
    };
  if (has("@sveltejs/kit"))
    return {
      name: "SvelteKit",
      integration: "@sweetener/unplugin",
      wiring: viteWiring("@sweetener/unplugin/vite", "plugins: ["),
    };
  if (has("nuxt"))
    return {
      name: "Nuxt",
      integration: "@sweetener/unplugin",
      wiring: viteWiring("@sweetener/unplugin/vite", "vite: { plugins: ["),
    };
  if (has("astro"))
    return {
      name: "Astro",
      integration: "@sweetener/unplugin",
      wiring: viteWiring("@sweetener/unplugin/vite", "vite: { plugins: ["),
    };
  // Before Rspack and webpack: an Rsbuild project depends on Rsbuild, and the
  // entry point that knows how to register with it is the one it wants.
  if (has("@rsbuild/core"))
    return {
      name: "Rsbuild",
      integration: "@sweetener/unplugin",
      wiring: [
        `Add the plugin to rsbuild.config.ts:`,
        ``,
        `  import sweetener from "@sweetener/unplugin/rsbuild";`,
        `  import { resolve } from "node:path";`,
        ``,
        `  plugins: [`,
        `    sweetener({`,
        `      configFile: resolve(import.meta.dirname, "sweetener.json"),`,
        `    }),`,
        `  ]`,
      ],
    };
  if (has("@farmfe/core"))
    return {
      name: "Farm",
      integration: "@sweetener/unplugin",
      wiring: [
        `Add the plugin to farm.config.ts:`,
        ``,
        `  import sweetener from "@sweetener/unplugin/farm";`,
        `  import { resolve } from "node:path";`,
        ``,
        `  plugins: [`,
        `    sweetener({ configFile: resolve(process.cwd(), "sweetener.json") }),`,
        `  ]`,
        ``,
        `Farm bundles farm.config.ts into node_modules/.farm before running it,`,
        `so import.meta.dirname there is that directory, not this one.`,
      ],
    };
  if (has("vite"))
    return {
      name: "Vite",
      integration: "@sweetener/unplugin",
      wiring: viteWiring("@sweetener/unplugin/vite", "plugins: ["),
    };
  if (has("parcel") || has("@parcel/core"))
    return {
      name: "Parcel",
      integration: "@sweetener/parcel-transformer",
      wiring: [
        `Add the transformer to .parcelrc:`,
        ``,
        `  { "transformers": { "*.sts": ["@sweetener/parcel-transformer"] } }`,
      ],
    };
  if (has("webpack"))
    return {
      name: "webpack",
      integration: "@sweetener/webpack-loader",
      wiring: [
        `Add a rule to your webpack config:`,
        ``,
        `  {`,
        `    test: /\\.sts$/,`,
        `    use: {`,
        `      loader: "@sweetener/webpack-loader",`,
        `      options: { configFile: resolve("sweetener.json") },`,
        `    },`,
        `  }`,
      ],
    };
  if (has("jest"))
    return {
      name: "Jest",
      integration: "@sweetener/jest",
      wiring: [
        `Add the transform to your Jest config:`,
        ``,
        `  transform: {`,
        `    "^.+\\.sts$": ["@sweetener/jest", { configFile: "sweetener.json" }],`,
        `  }`,
        ``,
        `The configFile is what tells it which macros this project has, and`,
        `what to re-expand when one of them changes.`,
      ],
    };
  return undefined;
}

/**
 * The config beside a project that already builds itself.
 *
 * A bundler emits the result itself and only wants the expansion, so nothing
 * should be written to disk. Where no bundler was recognised the advice is to
 * run `sweetener build`, and a config that cannot emit would have reported
 * success while producing no files.
 */
const consumerConfig = (files: readonly string[], emit: boolean): string =>
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        skipLibCheck: true,
        // What lets an ordinary `.ts` file import a `.sts` one: with this on,
        // `sourceDeclarations` writes a `main.d.sts.ts` that TypeScript
        // resolves `./main.sts` through.
        allowArbitraryExtensions: true,
        ...(emit
          ? { declaration: true, outDir: "dist", rootDir: "src" }
          : { noEmit: true }),
      },
      // Under a bundler the rest of the app is TypeScript that imports these,
      // and without declarations beside them `tsc` cannot resolve the import
      // — which breaks the build script the project already had.
      sweet: { sourceDeclarations: true },
      files,
    },
    null,
    2,
  )}\n`;

/**
 * What to add to a project that already builds itself somehow.
 *
 * Nothing it already has is touched. The parts that belong in a file someone
 * else wrote — a bundler config — are printed rather than edited in.
 */
export function scaffoldIntoProject(options: {
  readonly directory: string;
  readonly manifest?:
    | {
        readonly dependencies?: Readonly<Record<string, string>> | undefined;
        readonly devDependencies?: Readonly<Record<string, string>> | undefined;
      }
    | undefined;
}): ScaffoldedProject {
  const host = detectHost({
    manifest: options.manifest,
    directory: options.directory,
  });
  const cli = cliSpecifier();
  const integration = host?.integration ?? "@sweetener/cli";
  // Telling someone to install what they have just run reads as though the
  // scaffolder did not look. The manifest says whether it is already there.
  const dependencies = {
    ...(options.manifest?.dependencies ?? {}),
    ...(options.manifest?.devDependencies ?? {}),
  };
  const install =
    cli.specifier.startsWith("link:") && host !== undefined
      ? `${integration} is not published yet. Add it as a link: dependency pointing into the checkout, the way ${cliSpecifier().specifier} does.`
      : integration in dependencies
        ? `${integration} is already a dependency here.`
        : `Install ${integration}.`;
  return Object.freeze({
    files: Object.freeze([
      {
        path: "sweetener.json",
        text: consumerConfig(
          ["src/macros.sts", "src/example.sts"],
          host === undefined,
        ),
      },
      { path: join("src", "macros.sts"), text: macros },
      { path: join("src", "example.sts"), text: main },
    ]),
    notes: Object.freeze([
      host === undefined
        ? "No bundler was recognised here, so this project is set up for the command line: `sweetener build -p sweetener.json` expands into TypeScript you can compile or run."
        : `Detected ${host.name}.`,
      install,
      host === undefined
        ? "Run `sweetener build -p sweetener.json` to expand, or see examples/ for a bundler setup."
        : host.wiring.join("\n"),
      "sweetener.json lists the files to expand. Add your own .sts files to it.",
      "`sweetener build` writes a .d.sts.ts beside each .sts so ordinary TypeScript can import it. Add `*.d.sts.ts` and `*.d.stsx.ts` to .gitignore.",
      "Nothing you already had was modified.",
    ]),
  });
}
