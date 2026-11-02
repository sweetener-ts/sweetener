import { scriptKindForFileName } from "@sweetener/compiler";
import * as ts from "typescript";

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
 * Asks, of names copied from one source token, whether every copy means the
 * same thing.
 *
 * Binds the expanded file on its own -- no lib, no imports followed -- which
 * is enough to tell one local declaration from another: an import resolves to
 * its own alias, the same for every copy. A name that resolves to nothing
 * proves nothing: a global, and a property of something untyped, both resolve
 * to nothing here, and a copy of each is not one binding. Only a file with a
 * token copied more than once pays for the program.
 */
export function createBindingAgreement(
  virtualText: string,
  extension: string,
): (
  copies: readonly { readonly start: number; readonly end: number }[],
) => boolean {
  let checker:
    | { names: ReadonlyMap<string, ts.Node>; checker: ts.TypeChecker }
    | undefined;
  const bound = () => {
    if (checker !== undefined) return checker;
    const fileName = `/sweetener-expansion${extension}`;
    const sourceFile = ts.createSourceFile(
      fileName,
      virtualText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFileName(fileName),
    );
    const options: ts.CompilerOptions = {
      noLib: true,
      noResolve: true,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      types: [],
    };
    const program = ts.createProgram({
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
    });
    checker = {
      names: namesIn(sourceFile),
      checker: program.getTypeChecker(),
    };
    return checker;
  };
  return (copies) => {
    const { names, checker: typeChecker } = bound();
    let first: ts.Symbol | null = null;
    for (const { start, end } of copies) {
      const identifier = names.get(`${start}:${end}`);
      // A copy that is not an identifier here -- a property name the parser
      // reads differently, a keyword -- has nothing to compare, and nothing
      // is proven about it.
      if (identifier === undefined) return false;
      const symbol = typeChecker.getSymbolAtLocation(identifier);
      if (symbol === undefined) return false;
      if (first === null) first = symbol;
      else if (symbol !== first) return false;
    }
    return true;
  };
}
