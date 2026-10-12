import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPersonalWikiRoot,
  getVaultPaths,
  isPersonalVault,
  resolveProjectVaultRoot,
  resolveVaultRoot,
} from "../extensions/llm-wiki/lib/utils.js";

/**
 * `WIKI_ROOT` pins the vault for one host or one session, ahead of any vault
 * that detection would find.
 *
 * The case that motivates the precedence: a personal vault at its default
 * location puts the dot-dir straight inside the home directory, so that
 * directory is itself a vault root and a session started there has no project
 * for detection to find. A pin placed below that check would be ignored
 * exactly where an embedding host needs it to hold, because the host pins a
 * root in order to route a session away from the vault it is standing in.
 */

let tmpDir: string;
let priorWikiHome: string | undefined;
let priorWikiRoot: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `llm-wiki-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  priorWikiHome = process.env.WIKI_HOME;
  priorWikiRoot = process.env.WIKI_ROOT;
  for (const key of ["WIKI_HOME", "WIKI_ROOT"] as const) delete process.env[key];
});

afterEach(() => {
  const restore: Array<[string, string | undefined]> = [
    ["WIKI_HOME", priorWikiHome],
    ["WIKI_ROOT", priorWikiRoot],
  ];
  for (const [key, value] of restore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a vault sentinel (the directory is all `detectVaultFormat` needs). */
function makeVault(dir: string): string {
  mkdirSync(join(dir, ".llm-wiki"), { recursive: true });
  return dir;
}

describe("WIKI_ROOT pin", () => {
  it("outranks a vault rooted in the working directory", () => {
    const project = makeVault(join(tmpDir, "project"));
    const pinned = makeVault(join(tmpDir, "pinned"));
    process.env.WIKI_ROOT = pinned;
    expect(resolveProjectVaultRoot(project)).toBe(pinned);
  });

  it("routes a session started in the personal-vault root to the pin", () => {
    // A personal vault at its default location puts the dot-dir straight inside
    // the home directory, which makes that directory a vault root by the same
    // test detection uses.  WIKI_HOME relocates the personal root, so the case
    // is reproducible here without writing to anyone's real home.
    const personal = makeVault(join(tmpDir, "home"));
    process.env.WIKI_HOME = personal;
    const tree = makeVault(join(tmpDir, "tree"));
    expect(resolveProjectVaultRoot(personal)).toBe(personal);

    process.env.WIKI_ROOT = tree;
    expect(resolveProjectVaultRoot(personal)).toBe(tree);
    expect(resolveVaultRoot(personal)).toBe(tree);
  });

  it("outranks WIKI_HOME", () => {
    process.env.WIKI_HOME = join(tmpDir, "personal");
    const pinned = join(tmpDir, "pinned");
    process.env.WIKI_ROOT = pinned;
    expect(resolveProjectVaultRoot(tmpDir)).toBe(pinned);
  });

  it("treats an empty or whitespace value as unset", () => {
    const project = makeVault(join(tmpDir, "project2"));
    process.env.WIKI_ROOT = "   ";
    expect(resolveProjectVaultRoot(project)).toBe(project);
  });

  it("leaves the rest of the priority alone when unset", () => {
    const root = makeVault(join(tmpDir, "mono"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    // An ancestor vault, with nothing pinned and nothing chosen.
    expect(resolveProjectVaultRoot(nested)).toBe(root);

    // A chosen personal root beats that ancestor walk.
    process.env.WIKI_HOME = join(tmpDir, "chosen");
    expect(resolveProjectVaultRoot(nested)).toBe(join(tmpDir, "chosen"));
  });
});

describe("what the pin leaves alone", () => {
  it("does not move the personal root", () => {
    process.env.WIKI_HOME = makeVault(join(tmpDir, "home2"));
    const personal = getPersonalWikiRoot();
    process.env.WIKI_ROOT = makeVault(join(tmpDir, "tree2"));

    expect(getPersonalWikiRoot()).toBe(personal);
  });

  it("keeps the personal vault recognized as personal while pinned", () => {
    // Layered recall asks this question to decide whether to search a second
    // vault. A pin that answered "no" would make the user's own vault look like
    // an unrelated project and silently drop it from recall.
    const personal = makeVault(join(tmpDir, "home3"));
    process.env.WIKI_HOME = personal;
    process.env.WIKI_ROOT = makeVault(join(tmpDir, "tree3"));

    expect(isPersonalVault(getVaultPaths(personal))).toBe(true);
  });

  it("still returns null for a directory with no vault and no pin", () => {
    const bare = join(tmpDir, "bare");
    mkdirSync(bare, { recursive: true });
    expect(resolveProjectVaultRoot(bare)).toBeNull();
  });
});
