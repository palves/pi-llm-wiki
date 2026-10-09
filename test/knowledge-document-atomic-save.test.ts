import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FsCalls } from "./fs-call-recorder";

/**
 * Guarantees for a page save, which is the most common write in the vault:
 * `wiki_observe`, `wiki_retro` and `wiki_ensure_page` all arrive at
 * `writeKnowledgeDocumentFile`, as does every synthesis step in the ingest worker.
 *
 * - A reader running beside a save sees either the previous document or the new
 *   one. Pages are parsed as authoritative -- recall reads them, the embedding
 *   sweep hashes every file under `wiki/` on each pass -- and a truncated page
 *   parses as a frontmatter error rather than as a write in progress, so the
 *   reader's failure would be reported as a broken page.
 * - A save that fails partway leaves the previous page and no temporary file.
 * - The bytes are exactly what the serializer produced. Page content is versioned
 *   and diffed, so formatting is part of the contract.
 *
 * Assertions follow the sidecar tests: recorded filesystem calls rather than
 * timing, and the target must never be opened for writing at all.
 */
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

import {
  createKnowledgeDocument,
  readKnowledgeDocumentFile,
  serializeKnowledgeDocument,
  writeKnowledgeDocumentFile,
} from "../extensions/llm-wiki/lib/knowledge-document.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchDir(name: string): string {
  const root = join(
    import.meta.dirname,
    "..",
    "tmp",
    `page-save-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * A page path with its directory already present. Tests that are not about
 * directory creation set the directory up themselves, so a pre-fix writer fails on
 * the guarantee under test rather than on a missing directory.
 */
function pageFile(root: string, ...segments: string[]): string {
  const dir = join(root, ...segments.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  return join(root, ...segments);
}

/** A page with enough body text that one write spans many filesystem calls. */
function page(root: string, marker: string) {
  const body = Array.from(
    { length: 200 },
    (_, i) => `${marker} paragraph ${i}: ${"filler ".repeat(20)}`,
  ).join("\n\n");
  return createKnowledgeDocument(
    join(root, "sources/page.md"),
    { type: "source", title: marker },
    body,
  );
}

describe("writeKnowledgeDocumentFile", () => {
  it("fills a temporary file and renames it in, never opening the page for writing", () => {
    const root = scratchDir("calls");
    const path = pageFile(root, "sources", "page.md");
    writeKnowledgeDocumentFile(path, page(root, "first"));
    fsControl.openedForWrite.length = 0;
    fsControl.renames.length = 0;

    writeKnowledgeDocumentFile(path, page(root, "second"));

    expect(fsControl.openedForWrite).not.toContain(path);
    expect(fsControl.renames).toHaveLength(1);
    const [temporary, destination] = fsControl.renames[0];
    expect(destination).toBe(path);
    expect(temporary).toMatch(/\.tmp-\d+-[\w-]+$/);
    // A rename that crosses a filesystem boundary degrades into a copy and reopens
    // the window this exists to close.
    expect(dirname(temporary)).toBe(dirname(path));
  });

  it("keeps the previous page when the write fails partway", () => {
    const root = scratchDir("failure");
    const path = pageFile(root, "sources", "page.md");
    writeKnowledgeDocumentFile(path, page(root, "committed"));
    const original = readFileSync(path, "utf8");

    fsControl.failNextWrite = true;
    expect(() => writeKnowledgeDocumentFile(path, page(root, "abandoned"))).toThrow(
      /simulated write failure/,
    );

    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(join(root, "sources")).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("writes exactly the bytes the serializer produces", () => {
    const root = scratchDir("bytes");
    const path = pageFile(root, "sources", "page.md");
    const document = page(root, "verbatim");
    writeKnowledgeDocumentFile(path, document);
    expect(readFileSync(path, "utf8")).toBe(serializeKnowledgeDocument(document));
  });

  it("creates the directory a new page type needs", () => {
    // A save into an absent directory used to fail with ENOENT. It succeeds now,
    // which is what a caller that has just invented a page type needs; pinned here
    // so the change is a decision rather than a side effect.
    const root = scratchDir("mkdir");
    const path = join(root, "cases", "deep", "page.md");
    writeKnowledgeDocumentFile(path, page(root, "nested"));
    expect(readFileSync(path, "utf8")).toContain("nested");
  });

  it("round-trips through the reader", () => {
    const root = scratchDir("roundtrip");
    const path = pageFile(root, "sources", "page.md");
    writeKnowledgeDocumentFile(path, page(root, "observable"));
    const result = readKnowledgeDocumentFile(path, "sources/page.md");
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (result.ok) expect(result.document.frontmatter.title).toBe("observable");
  });
});
