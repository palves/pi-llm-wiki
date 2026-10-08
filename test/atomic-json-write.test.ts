import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FsCalls } from "./fs-call-recorder";

/**
 * Guarantees for the generated JSON projections -- `meta/registry.json`,
 * `meta/backlinks.json`, `meta/embeddings.json`, source packets and
 * trajectories:
 *
 * - A concurrent reader sees either the previously committed bytes or the
 *   complete new ones. Never an empty file, never a partial one. Readers take
 *   the store as authoritative, and a reader that cannot parse it falls back to
 *   "there is nothing here", so a gap in this guarantee is silent rather than
 *   loud.
 * - A write that fails partway leaves the previous content intact and leaves no
 *   temporary file in the directory.
 * - The bytes on disk are stable: two-space indent, trailing newline, utf-8.
 *   These files are diffed and versioned, so the format is part of the contract.
 * - Every write to a given file stays within that file's own directory, since a
 *   rename across filesystems degrades to a copy and reopens the gap above.
 *
 * Assertions are built on recorded filesystem calls rather than on timing: the
 * writer must never open the target for writing at all, and it must reach the target
 * through a single rename whose temp file sits in the target's own directory. Whether a rename
 * is atomic for a reader in another process is the filesystem's promise rather than
 * this code's, so it is not tested here; the properties above are the ones that can
 * regress silently, and they are the ones pinned. Inode numbers are deliberately not
 * used -- the filesystem recycles them, so a repeated write to one directory can
 * legitimately present the same number before and after a correct temp-and-rename.
 */

// The recorder's state is built inside vi.hoisted because vi.mock is hoisted above
// this file's imports, and the recorder itself is pulled in with a dynamic import from
// inside the factory: a static import would still be in its temporal dead zone when
// node:fs is first requested, which is during this file's own import phase.
const fsControl = vi.hoisted(
  (): FsCalls => ({
    failNextWrite: false,
    openedForWrite: [],
    renames: [],
  }),
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { instrumentNodeFs } = await import("./fs-call-recorder");
  return instrumentNodeFs(fsControl, actual);
});

import { atomicWriteFile, writeJson } from "../extensions/llm-wiki/lib/utils.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchDir(name: string): string {
  const root = join(
    import.meta.dirname,
    "..",
    "tmp",
    `atomic-json-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Large enough that a single write spans many filesystem calls. */
function vectorStore(entryCount = 400): Record<string, unknown> {
  return {
    version: "1.0",
    entries: Object.fromEntries(
      Array.from({ length: entryCount }, (_, i) => [
        `sources/page-${i}`,
        {
          hash: `${i}`.repeat(40),
          model: "test",
          dim: 64,
          vector: Array.from({ length: 64 }, () => 0.01),
        },
      ]),
    ),
  };
}

describe("writeJson", () => {
  it("fills a temporary file and renames it in, never opening the target for writing", () => {
    // The contract a reader depends on: the bytes at the target path are only
    // ever swapped in wholesale. Opening the target for writing truncates it
    // first, which is the window the guarantee exists to close.
    const path = join(scratchDir("calls"), "embeddings.json");
    writeJson(path, { warm: true });
    fsControl.openedForWrite.length = 0;
    fsControl.renames.length = 0;

    writeJson(path, vectorStore(20));

    expect(fsControl.openedForWrite).not.toContain(path);
    expect(fsControl.renames).toHaveLength(1);
    const [temporary, destination] = fsControl.renames[0];
    expect(destination).toBe(path);
    expect(temporary).toMatch(/\.tmp-\d+-[\w-]+$/);
    // The temp must live beside the target: a rename that crosses a filesystem
    // boundary degrades into a copy and reopens the window.
    expect(dirname(temporary)).toBe(dirname(path));
  });

  it("keeps the previous content when the write fails partway", () => {
    const root = scratchDir("failure");
    const path = join(root, "embeddings.json");
    writeJson(path, { vectors: vectorStore().entries });
    const original = readFileSync(path, "utf8");

    fsControl.failNextWrite = true;
    expect(() => writeJson(path, { vectors: "replaced" })).toThrow(/simulated write failure/);

    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps separate writes in one process from colliding on the temporary file", () => {
    // Temp names carry the pid, which does not distinguish two writes from the
    // same process, so the random suffix is what stops them overwriting each
    // other's partially written file.
    const root = scratchDir("temp-names");
    const path = join(root, "registry.json");
    writeJson(path, { first: vectorStore(5) });
    writeJson(path, { second: vectorStore(5) });

    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(persisted)).toEqual(["second"]);
    expect(readdirSync(root)).toEqual(["registry.json"]);
  });

  it("writes the same bytes a truncating writer would have produced", () => {
    const path = join(scratchDir("bytes"), "registry.json");
    const data = { pages: { "sources/a": { type: "source", title: "A" } } };
    writeJson(path, data);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(data, null, 2)}\n`);
  });

  it("leaves no temporary file behind once a write succeeds", () => {
    const root = scratchDir("litter");
    const path = join(root, "backlinks.json");
    writeJson(path, vectorStore(50));
    writeJson(path, vectorStore(60));
    expect(readdirSync(root)).toEqual(["backlinks.json"]);
  });
});

describe("atomicWriteFile", () => {
  it("creates the parent directory when it is missing", () => {
    const path = join(scratchDir("mkdir"), "deep", "meta", "embeddings.json");
    atomicWriteFile(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });

  it("keeps the temporary file out of the directory listing after a success", () => {
    const root = scratchDir("same-dir");
    const path = join(root, "store.json");
    writeJson(path, { first: true });
    writeJson(path, { second: true });
    writeJson(path, { third: true });
    expect(readdirSync(root)).toEqual(["store.json"]);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ third: true }, null, 2)}\n`);
  });
});
