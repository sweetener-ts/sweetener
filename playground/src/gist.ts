import type { PlaygroundFile } from "./examples";
import {
  checkProjectFiles,
  checkSourceFileName,
  manifestName,
} from "./project-files";

const ignoredFileNames = new Set(["README.md"]);
const gistId = /^[0-9a-f]{5,64}$/iu;

type GistFile = {
  filename?: string;
  content?: string;
  truncated?: boolean;
};

type GistResponse = {
  description?: string | null;
  files?: Record<string, GistFile>;
};

type PlaygroundManifest = {
  version: 1;
  entryFileName: string;
  name?: string;
  summary?: string;
};

export type GistProject = {
  id: string;
  name: string;
  summary: string;
  entryFileName: string;
  files: PlaygroundFile[];
};

export function parseGistReference(reference: string): string | undefined {
  const value = reference.trim();
  if (gistId.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname !== "gist.github.com") return undefined;
    const candidate = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return gistId.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function resolveGistLoad(
  reference: string,
  currentGistId: string,
): { id: string; reload: boolean } | undefined {
  const id = parseGistReference(reference);
  return id === undefined ? undefined : { id, reload: id === currentGistId };
}

function parseManifest(
  file: GistFile | undefined,
): PlaygroundManifest | undefined {
  if (file === undefined) return undefined;
  if (file.content === undefined)
    throw new Error(`${manifestName} is truncated or unavailable.`);
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch {
    throw new Error(`${manifestName} is not valid JSON.`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<PlaygroundManifest>).version !== 1 ||
    typeof (value as Partial<PlaygroundManifest>).entryFileName !== "string"
  )
    throw new Error(
      `${manifestName} must declare version 1 and entryFileName.`,
    );
  return value as PlaygroundManifest;
}

function inferEntryFileName(files: readonly PlaygroundFile[]): string {
  for (const conventionalName of [
    "main.sts",
    "main.stsx",
    "index.sts",
    "index.stsx",
  ]) {
    if (files.some(({ fileName }) => fileName === conventionalName))
      return conventionalName;
  }

  const macroSources = files.filter(({ fileName }) =>
    /\.stsx?$/u.test(fileName),
  );
  if (macroSources.length === 1) return macroSources[0]!.fileName;
  if (files.length === 1) return files[0]!.fileName;

  throw new Error(
    `Gist has multiple possible entry files. Add ${manifestName} to choose one.`,
  );
}

export function projectFromGist(id: string, gist: GistResponse): GistProject {
  const sourceFiles = gist.files ?? {};
  const manifest = parseManifest(sourceFiles[manifestName]);
  const files: PlaygroundFile[] = [];

  for (const [key, file] of Object.entries(sourceFiles)) {
    if (key === manifestName) continue;
    const fileName = file.filename ?? key;
    if (ignoredFileNames.has(fileName)) continue;
    checkSourceFileName("Gist", fileName);
    if (file.truncated || file.content === undefined)
      throw new Error(`${fileName} is truncated or unavailable.`);
    files.push({ fileName, source: file.content });
  }

  if (files.length === 0) throw new Error("Gist contains no source files.");
  const entryFileName = manifest?.entryFileName ?? inferEntryFileName(files);
  checkProjectFiles("Gist", files, entryFileName);

  return {
    id,
    name: manifest?.name?.trim() || `Gist ${id.slice(0, 8)}`,
    summary:
      manifest?.summary?.trim() ||
      gist.description?.trim() ||
      "Loaded from a GitHub Gist.",
    entryFileName,
    files,
  };
}

export async function loadGistProject(
  id: string,
  signal?: AbortSignal,
): Promise<GistProject> {
  if (!gistId.test(id)) throw new Error("Invalid GitHub Gist ID.");
  const response = await fetch(`https://api.github.com/gists/${id}`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) {
    if (response.status === 404)
      throw new Error("Gist was not found or is private.");
    throw new Error(
      `GitHub returned ${response.status} while loading the Gist.`,
    );
  }
  return projectFromGist(id, (await response.json()) as GistResponse);
}
