import * as ts from "typescript";

const scriptKinds: ReadonlyMap<string, ts.ScriptKind> = new Map([
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

function identifierAt(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (
      found !== undefined ||
      node.getStart(sourceFile) > start ||
      node.end < end
    )
      return;
    if (
      ts.isIdentifier(node) &&
      node.getStart(sourceFile) === start &&
      node.end === end
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Asks, of names copied from one source token, whether every copy means the
 * same thing.
 *
 * Binds the expanded file on its own -- no lib, no imports followed -- which
 * is enough to tell one local declaration from another: an import resolves to
 * its own alias, and a global to nothing, the same for every copy. Only a
 * file with a token copied more than once pays for the program.
 */
export function createBindingAgreement(
  virtualText: string,
  extension: string,
): (
  copies: readonly { readonly start: number; readonly end: number }[],
) => boolean {
  let checker:
    { sourceFile: ts.SourceFile; checker: ts.TypeChecker } | undefined;
  const bound = () => {
    if (checker !== undefined) return checker;
    const scriptKind = scriptKinds.get(extension);
    if (scriptKind === undefined)
      throw new Error(
        `Sweetener cannot bind an expansion written as ${extension}`,
      );
    const fileName = `/sweetener-expansion${extension}`;
    const sourceFile = ts.createSourceFile(
      fileName,
      virtualText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
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
    checker = { sourceFile, checker: program.getTypeChecker() };
    return checker;
  };
  return (copies) => {
    const { sourceFile, checker: typeChecker } = bound();
    let first: ts.Symbol | undefined | null = null;
    for (const { start, end } of copies) {
      const identifier = identifierAt(sourceFile, start, end);
      // A copy that is not an identifier here -- a property name the parser
      // reads differently, a keyword -- has nothing to compare, and nothing
      // is proven about it.
      if (identifier === undefined) return false;
      const symbol = typeChecker.getSymbolAtLocation(identifier);
      if (first === null) first = symbol;
      else if (symbol !== first) return false;
    }
    return true;
  };
}
