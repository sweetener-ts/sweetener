import { scriptKindForFileName } from "@sweetener/compiler";
import * as ts from "typescript";

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
    { sourceFile: ts.SourceFile; checker: ts.TypeChecker } | undefined;
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
    checker = { sourceFile, checker: program.getTypeChecker() };
    return checker;
  };
  return (copies) => {
    const { sourceFile, checker: typeChecker } = bound();
    let first: ts.Symbol | null = null;
    for (const { start, end } of copies) {
      const identifier = identifierAt(sourceFile, start, end);
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
