import { typescript as ts } from "@sweetener/compiler";

/** Every name in a file, by where it stands: found once, for all its copies. */
function namesIn(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const names = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node))
      names.set(`${node.getStart(sourceFile)}:${node.end}`, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/**
 * Whether a name stands for two: `{ x }` is a property `x` holding `x`, and
 * `export { x }` is a local `x` exported as `x`. Renaming either one, TypeScript
 * keeps the other by spelling both, `x: renamed`, which is right for a file
 * that wrote it so.
 */
function abbreviatesTwo(name: ts.Node): boolean {
  const { parent } = name;
  return (
    (ts.isShorthandPropertyAssignment(parent) && parent.name === name) ||
    ((ts.isExportSpecifier(parent) || ts.isImportSpecifier(parent)) &&
      parent.propertyName === undefined) ||
    (ts.isBindingElement(parent) &&
      ts.isObjectBindingPattern(parent.parent) &&
      parent.name === name &&
      parent.propertyName === undefined)
  );
}

/** Whether TypeScript reads a text as a module whatever its config says. */
function readsAsModule(text: string, extension: string): boolean {
  return (
    /\b(?:import|export)\b/u.test(text) &&
    ts.isExternalModule(
      ts.createSourceFile(
        `/sweetener-expansion${extension}`,
        text,
        ts.ScriptTarget.Latest,
      ),
    )
  );
}

/**
 * Whether a text needs saying it is a module, as every Sweetener source is, which
 * `sweetener check` says by its `moduleDetection`. Not JavaScript using what
 * CommonJS provides: TypeScript goes by those names, whose meaning an `export`
 * would take away, where `moduleDetection` leaves it.
 */
export function needsModuleMarker(text: string, extension: string): boolean {
  return (
    !readsAsModule(text, extension) &&
    !(
      /^\.[cm]?jsx?$/u.test(extension) &&
      /\b(?:exports|module|require)\b/u.test(text)
    )
  );
}

/** What can be asked of names at places in one expanded file. */
export interface BindingAgreement {
  /** Whether names copied from one source token all mean the same thing. */
  agree(copies: readonly TextPlace[]): boolean;
  /** Whether the name at a place stands for two: see `abbreviatesTwo`. */
  abbreviates(copy: TextPlace): boolean;
}

interface TextPlace {
  readonly start: number;
  readonly end: number;
}

/**
 * Binds the expanded file on its own -- no lib, no imports followed -- which
 * is enough to tell one local declaration from another: an import resolves to
 * its own alias, the same for every copy. A name that resolves to nothing
 * proves nothing: a global, and a property of something untyped, both resolve
 * to nothing here, and a copy of each is not one binding. A file parses only
 * if a macro copied a name in it, and binds only if one was copied twice.
 */
export function createBindingAgreement(
  virtualText: string,
  extension: string,
): BindingAgreement {
  const fileName = `/sweetener-expansion${extension}`;
  let parsed:
    | {
        readonly sourceFile: ts.SourceFile;
        readonly names: ReadonlyMap<string, ts.Node>;
      }
    | undefined;
  const parse = () => {
    if (parsed !== undefined) return parsed;
    const sourceFile = ts.createSourceFile(
      fileName,
      virtualText,
      ts.ScriptTarget.Latest,
      true,
    );
    parsed = { sourceFile, names: namesIn(sourceFile) };
    return parsed;
  };
  let checker: ts.TypeChecker | undefined;
  const bound = () => {
    if (checker !== undefined) return checker;
    const { sourceFile } = parse();
    const options: ts.CompilerOptions = {
      noLib: true,
      noResolve: true,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      types: [],
    };
    checker = ts
      .createProgram({
        rootNames: [fileName],
        options,
        host: {
          getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
          getDefaultLibFileName: () => "/lib.d.ts",
          writeFile: () => {},
          getCurrentDirectory: () => "/",
          getCanonicalFileName: (name) => name,
          useCaseSensitiveFileNames: () => true,
          getNewLine: () => "\n",
          fileExists: (name) => name === fileName,
          readFile: (name) => (name === fileName ? virtualText : undefined),
        },
      })
      .getTypeChecker();
    return checker;
  };
  return {
    agree: (copies) => {
      const { names } = parse();
      const typeChecker = bound();
      let first: ts.Symbol | null = null;
      for (const { start, end } of copies) {
        const name = names.get(`${start}:${end}`);
        // A copy that is not a name here -- a keyword, or a property name the
        // parser reads differently -- has nothing to compare, and nothing is
        // proven about it.
        if (name === undefined) return false;
        const symbol = typeChecker.getSymbolAtLocation(name);
        if (symbol === undefined) return false;
        if (first === null) first = symbol;
        else if (symbol !== first) return false;
      }
      return true;
    },
    abbreviates: ({ start, end }) => {
      const name = parse().names.get(`${start}:${end}`);
      return name !== undefined && abbreviatesTwo(name);
    },
  };
}
