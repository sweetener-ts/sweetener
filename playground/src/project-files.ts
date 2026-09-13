import type { PlaygroundFile } from "./examples";

export const manifestName = "sweetener-playground.json";
const allowedFileName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:d\.ts|stsx?|tsx?)$/u;
const safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const maximumFiles = 32;
const maximumFileBytes = 256 * 1024;
export const maximumProjectBytes = 512 * 1024;

/**
 * The limits every project loaded from outside the site must meet, whether it
 * came from a Gist or a shared link. `origin` names where it came from, so an
 * error says which one broke the rule.
 */
export function checkSourceFileName(origin: string, fileName: string): void {
  if (!safeFileName.test(fileName))
    throw new Error(`Unsafe ${origin} filename: ${fileName}`);
  if (!allowedFileName.test(fileName))
    throw new Error(`Unsupported ${origin} source filename: ${fileName}`);
}

export function checkProjectFiles(
  origin: string,
  files: readonly PlaygroundFile[],
  entryFileName: string,
): void {
  if (files.length === 0)
    throw new Error(`${origin} contains no source files.`);
  if (files.length > maximumFiles)
    throw new Error(`${origin} exceeds the ${maximumFiles}-file limit.`);
  const seen = new Set<string>();
  let projectBytes = 0;
  for (const { fileName, source } of files) {
    checkSourceFileName(origin, fileName);
    if (seen.has(fileName))
      throw new Error(`${origin} contains ${fileName} more than once.`);
    seen.add(fileName);
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maximumFileBytes)
      throw new Error(`${fileName} exceeds the 256 KiB file limit.`);
    projectBytes += bytes;
  }
  if (projectBytes > maximumProjectBytes)
    throw new Error(`${origin} exceeds the 512 KiB project limit.`);
  if (!seen.has(entryFileName))
    throw new Error(`Entry file ${entryFileName} is missing.`);
}
