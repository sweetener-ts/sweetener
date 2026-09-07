let files = new Map<string, string>();

const normalize = (fileName: string) =>
  fileName.replaceAll("\\", "/").replace(/\/+/gu, "/");

export function setVirtualFiles(next: ReadonlyMap<string, string>): void {
  files = new Map([...next].map(([name, source]) => [normalize(name), source]));
}

export function existsSync(fileName: string): boolean {
  return files.has(normalize(fileName));
}

export function realpathSync(fileName: string): string {
  const normalized = normalize(fileName);
  if (!files.has(normalized)) throw new Error(`ENOENT: ${fileName}`);
  return normalized;
}

export function readFileSync(fileName: string, encoding?: string): string {
  const source = files.get(normalize(fileName));
  if (source === undefined) throw new Error(`ENOENT: ${fileName}`);
  if (encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8")
    throw new Error(`Unsupported browser encoding: ${encoding}`);
  return source;
}

/**
 * The writing half of `node:fs`, which this shim cannot do and must not fake.
 *
 * `runConfiguredProjectCommand` writes source declarations and clears stale
 * ones, all of it behind `writeThrough`, which the playground never sets: it
 * expands in memory and hands the result back. Rolldown still has to resolve
 * the imports, though, so they have to exist here. Returning quietly would
 * mean a playground that silently dropped a file it was asked to write.
 */
function unwritable(operation: string, fileName: string): never {
  throw new Error(
    `The playground expands in memory and has no file system: ${operation} cannot write ${fileName}. This is reached only with writeThrough set, which the playground does not set.`,
  );
}

// Only the path is declared: these throw before they could use anything else,
// and the callers are in built JavaScript that passes what it likes.
export function writeFileSync(fileName: string): never {
  return unwritable("writeFileSync", fileName);
}

export function rmSync(fileName: string): never {
  return unwritable("rmSync", fileName);
}

export function readdirSync(directory: string): never {
  return unwritable("readdirSync", directory);
}
