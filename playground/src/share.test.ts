import { describe, expect, test } from "vitest";
import { examples } from "./examples";
import { decodeSharedProject, encodeSharedProject } from "./share";

async function deflate(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

describe("playground shared links", () => {
  test("round-trips every shipped example", async () => {
    for (const example of examples) {
      const project = {
        entryFileName: example.entryFileName,
        files: example.files,
      };
      const encoded = await encodeSharedProject(project);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(await decodeSharedProject(encoded)).toEqual(project);
    }
  });

  test("keeps non-ASCII source intact", async () => {
    const project = {
      entryFileName: "main.sts",
      files: [{ fileName: "main.sts", source: "const café = '→ ✓ 🍬';\n" }],
    };
    expect(
      await decodeSharedProject(await encodeSharedProject(project)),
    ).toEqual(project);
  });

  test("compresses repetitive source well below its length", async () => {
    const source = "export syntax unless:stmt {}\n".repeat(400);
    const encoded = await encodeSharedProject({
      entryFileName: "main.sts",
      files: [{ fileName: "main.sts", source }],
    });
    expect(encoded.length).toBeLessThan(source.length / 10);
  });

  test.each(["", "not base64!", "AAAA"])(
    "rejects the malformed payload %j",
    async (payload) => {
      await expect(decodeSharedProject(payload)).rejects.toThrow(
        "Shared code link is not valid.",
      );
    },
  );

  test("rejects a link cut short by whatever it was pasted into", async () => {
    const encoded = await encodeSharedProject({
      entryFileName: examples[0]!.entryFileName,
      files: examples[0]!.files,
    });
    await expect(
      decodeSharedProject(encoded.slice(0, Math.floor(encoded.length / 2))),
    ).rejects.toThrow("Shared code link is not valid.");
  });

  test("rejects a payload with the wrong shape", async () => {
    const wrong = await deflate(
      JSON.stringify({ version: 2, entryFileName: "main.sts", files: [] }),
    );
    await expect(decodeSharedProject(wrong)).rejects.toThrow(
      "Shared code link is not valid.",
    );
  });

  test("applies the same file rules as a Gist", async () => {
    const unsafe = await encodeSharedProject({
      entryFileName: "main.sts",
      files: [
        { fileName: "main.sts", source: "" },
        { fileName: "../escape.ts", source: "" },
      ],
    });
    await expect(decodeSharedProject(unsafe)).rejects.toThrow(
      "Unsafe Shared code filename: ../escape.ts",
    );
    const missingEntry = await encodeSharedProject({
      entryFileName: "main.sts",
      files: [{ fileName: "macros.sts", source: "" }],
    });
    await expect(decodeSharedProject(missingEntry)).rejects.toThrow(
      "Entry file main.sts is missing.",
    );
  });

  test("stops inflating a small link that expands past the limits", async () => {
    const bomb = await deflate("a".repeat(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(20_000);
    await expect(decodeSharedProject(bomb)).rejects.toThrow(
      "Shared code is larger than the playground accepts.",
    );
  });
});
