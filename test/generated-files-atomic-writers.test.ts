import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Generated files -- pages, packets, manifests, the sidecar, settings -- are read
 * while they are being written. Recall parses pages to rank a query, the metadata
 * rebuild walks the wiki tree, the embedding sweep hashes every page, and a detached
 * reader takes the JSON projections as authoritative and treats an unparseable file as
 * an empty one. So every one of those files has to be published by renaming a
 * completed temporary file into place, which is what `atomicWriteFile` and the
 * `writeJson` on top of it do.
 *
 * A file that writes one of those artifacts directly truncates it in place, and the
 * damage is invisible: the reader sees a document that is not there yet and reports it
 * as broken rather than as unfinished. That is why this is a test rather than a
 * comment. The next writer added in passing looks exactly like the eight that were
 * here before they were routed through the helper, and nothing in a diff of a single
 * function shows the difference.
 *
 * The exceptions below are not oversights. Each earns its place by carrying a
 * property the shared helper does not, so routing it through the helper would quietly
 * drop that property. The third field is the signature that proves the call is still
 * the exceptional one, so that a plain truncating write added to an exempt file fails
 * here instead of inheriting the exemption.
 */
const EXEMPT: Array<{ file: string; reason: string; isStillTheException: RegExp }> = [
  {
    file: "utils.ts",
    reason: "atomicWriteFile itself, filling the temporary file before the rename",
    isStillTheException: /writeFileSync\(\s*temporary\b/,
  },
  {
    file: "legacy-repair.ts",
    reason:
      "repair journals: exclusive temp, mode 0600 under a 0700 parent, fsync of file and directory",
    isStillTheException: /writeFileSync\(\s*handle\b/,
  },
  {
    file: "metadata.ts",
    reason: "the events.jsonl append, which is authoritative, append-only and merged by hand",
    isStillTheException: /writeFileSync\(.*flag:\s*"a"/,
  },
  {
    file: "lint.ts",
    reason: "the auto-fix page create, which must fail rather than clobber an existing page",
    isStillTheException: /writeFileSync\(.*flag:\s*"wx"/,
  },
];

const LIB_DIR = join(import.meta.dirname, "..", "extensions", "llm-wiki", "lib");

/**
 * Every direct call in a source file, with its arguments, whitespace-normalized.
 * Imports name the symbol without a paren, so they are not caught. Matching on the
 * whole call rather than on one line matters because the formatter wraps a call that
 * carries an options object, and the option that earns an exemption (`flag: "wx"`) is
 * exactly the kind of thing that ends up on a line of its own.
 */
function directCalls(source: string): string[] {
  const calls: string[] = [];
  const needle = "writeFileSync(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    let depth = 1;
    let i = at + needle.length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    calls.push(source.slice(at, i).replace(/\s+/g, " ").trim());
    from = i;
  }
  return calls;
}

const sources = readdirSync(LIB_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

describe("generated files are published atomically", () => {
  for (const name of sources) {
    const exemption = EXEMPT.find((entry) => entry.file === name);

    it(`${name} writes through the shared helper`, () => {
      const calls = directCalls(readFileSync(join(LIB_DIR, name), "utf8"));

      if (!exemption) {
        expect(calls, `${name} must use atomicWriteFile or writeJson`).toEqual([]);
        return;
      }

      for (const call of calls) {
        expect(call, `${name}: ${exemption.reason}`).toMatch(exemption.isStillTheException);
      }
    });
  }

  it("names only files that still exist, so the exemption list cannot go stale", () => {
    const present = new Set(sources);
    for (const entry of EXEMPT) {
      expect(present.has(entry.file), `exempt file ${entry.file} is gone; drop the exception`).toBe(
        true,
      );
    }
  });
});
