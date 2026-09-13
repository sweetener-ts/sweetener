import type { PlaygroundFile } from "./examples";
import {
  checkProjectFiles,
  maximumFiles,
  maximumProjectBytes,
} from "./project-files";

/**
 * A shared link carries the whole project in the fragment, so sharing needs no
 * server: `#/code/<payload>`, where the payload is the project as JSON,
 * deflated and base64url-encoded. The fragment is never sent to the host, so
 * the only limit on its length is whatever the link is pasted into.
 */
export type SharedProject = {
  entryFileName: string;
  files: PlaygroundFile[];
};

type SharedPayload = {
  version: 1;
  entryFileName: string;
  files: [fileName: string, source: string][];
};

// Enough for the largest project the limits allow, with every character
// escaped by JSON, and the names and structure around them.
const maximumPayloadBytes =
  maximumProjectBytes * 6 + maximumFiles * 1024 + 1024;

class TooLarge extends Error {
  constructor() {
    super("Shared code is larger than the playground accepts.");
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // Checked while reading rather than after, so a small link cannot
    // inflate into more memory than any real project needs.
    if (total > limit) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function transform(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new Blob([bytes]).stream();
  return readAll(source.pipeThrough(stream), limit);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(text))
    throw new Error("Shared code link is not valid.");
  const base64 = text.replace(/-/gu, "+").replace(/_/gu, "/");
  let binary: string;
  try {
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    throw new Error("Shared code link is not valid.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encodeSharedProject(
  project: SharedProject,
): Promise<string> {
  const payload: SharedPayload = {
    version: 1,
    entryFileName: project.entryFileName,
    files: project.files.map(({ fileName, source }) => [fileName, source]),
  };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await transform(
    json,
    new CompressionStream("deflate-raw"),
    Number.POSITIVE_INFINITY,
  );
  return toBase64Url(compressed);
}

export async function decodeSharedProject(
  encoded: string,
): Promise<SharedProject> {
  let json: Uint8Array;
  try {
    json = await transform(
      fromBase64Url(encoded),
      new DecompressionStream("deflate-raw"),
      maximumPayloadBytes,
    );
  } catch (error) {
    if (error instanceof TooLarge) throw error;
    throw new Error("Shared code link is not valid.", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
  } catch {
    throw new Error("Shared code link is not valid.");
  }
  const payload = value as Partial<SharedPayload> | null;
  if (
    typeof payload !== "object" ||
    payload === null ||
    payload.version !== 1 ||
    typeof payload.entryFileName !== "string" ||
    !Array.isArray(payload.files) ||
    !payload.files.every(
      (file) =>
        Array.isArray(file) &&
        file.length === 2 &&
        typeof file[0] === "string" &&
        typeof file[1] === "string",
    )
  )
    throw new Error("Shared code link is not valid.");
  const files = payload.files.map(([fileName, source]) => ({
    fileName,
    source,
  }));
  checkProjectFiles("Shared code", files, payload.entryFileName);
  return { entryFileName: payload.entryFileName, files };
}
