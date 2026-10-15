import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ctxSessionId,
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
let priorSessionRoots: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `llm-wiki-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  priorWikiHome = process.env.WIKI_HOME;
  priorWikiRoot = process.env.WIKI_ROOT;
  priorSessionRoots = process.env.WIKI_SESSION_ROOTS;
  for (const key of ["WIKI_HOME", "WIKI_ROOT", "WIKI_SESSION_ROOTS"] as const)
    delete process.env[key];
});

afterEach(() => {
  const restore: Array<[string, string | undefined]> = [
    ["WIKI_HOME", priorWikiHome],
    ["WIKI_ROOT", priorWikiRoot],
    ["WIKI_SESSION_ROOTS", priorSessionRoots],
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

/**
 * `WIKI_SESSION_ROOTS` names a directory of per-session vaults, so a host that runs
 * several sessions in one process can point each at its own without any one of them
 * reading a value another session wrote. The pin these tests most need to refuse is
 * the one left behind by a sibling: `WIKI_ROOT` is process-wide, so it describes
 * whoever set it last, and honouring it for a session that has a vault of its own is
 * how one conversation ends up reading and writing another's.
 */
const ROOTS = "roots";

function sessionVault(id: string): string {
  return makeVault(join(tmpDir, ROOTS, id));
}

describe("WIKI_SESSION_ROOTS", () => {
  it("gives two sessions in one process two different vaults", () => {
    // The property the whole mechanism exists for, stated as a single assertion
    // pair: the same call, the same working directory, differing only in whose
    // conversation is asking.
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);
    const a = sessionVault("session-a");
    const b = sessionVault("session-b");

    expect(resolveProjectVaultRoot(tmpDir, "session-a")).toBe(a);
    expect(resolveProjectVaultRoot(tmpDir, "session-b")).toBe(b);
  });

  it("outranks the process-wide pin, which may belong to a sibling", () => {
    // A stale WIKI_ROOT naming session-a must not capture session-b's calls.
    // Reordering these two lines is the mutation this test exists to catch.
    const mine = sessionVault("session-b");
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);
    process.env.WIKI_ROOT = sessionVault("session-a");

    expect(resolveProjectVaultRoot(tmpDir, "session-b")).toBe(mine);
  });

  it("outranks a vault found in the working directory", () => {
    const project = makeVault(join(tmpDir, "project"));
    const mine = sessionVault("session-c");
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);

    expect(resolveProjectVaultRoot(project, "session-c")).toBe(mine);
  });

  it("declines a session directory that holds no vault, rather than writing into it", () => {
    // Materialising the checkout is the sync layer's job and it may not have
    // reached this session. An answer of "yes" here would put pages in a bare
    // directory no publish reads, which is the failure the marker test prevents.
    const halfMade = join(tmpDir, ROOTS, "session-d");
    mkdirSync(halfMade, { recursive: true });
    const project = makeVault(join(tmpDir, "project"));
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);

    expect(resolveProjectVaultRoot(project, "session-d")).toBe(project);
  });

  it("declines a session directory that does not exist at all", () => {
    const project = makeVault(join(tmpDir, "project"));
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);

    expect(resolveProjectVaultRoot(project, "never-bound")).toBe(project);
  });

  it("does nothing when the caller has no session to name", () => {
    // The MCP server, the Claude hooks and a plain shell have no session. With
    // the variable set and no id, resolution must be what it always was.
    const project = makeVault(join(tmpDir, "project"));
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);
    sessionVault("somebody-else");

    expect(resolveProjectVaultRoot(project)).toBe(project);
    expect(resolveProjectVaultRoot(project, undefined)).toBe(project);
  });

  it("treats an empty or whitespace value as unset, and a padded path as that path", () => {
    // Both halves are needed. Dropping the trim alone would still "work" if only
    // the blank case were tested, because a blank base joins to a path that
    // cannot exist and the resolver declines for the wrong reason. The padded
    // base is what forces the trim to be doing the work.
    const project = makeVault(join(tmpDir, "project"));
    const mine = sessionVault("session-e");
    process.env.WIKI_SESSION_ROOTS = "  ";
    expect(resolveProjectVaultRoot(project, "session-e")).toBe(project);

    process.env.WIKI_SESSION_ROOTS = `  ${join(tmpDir, ROOTS)}  `;
    expect(resolveProjectVaultRoot(project, "session-e")).toBe(mine);
  });

  it("counts as the personal root of the session that holds it", () => {
    // A session working in a checkout of its own has that checkout as its whole
    // wiki. If layered recall answered "home" here it would merge the shared
    // store into the session's own search and compare against somebody else's
    // state.
    const mine = sessionVault("session-f");
    process.env.WIKI_SESSION_ROOTS = join(tmpDir, ROOTS);
    process.env.WIKI_HOME = join(tmpDir, "home6");

    expect(getPersonalWikiRoot("session-f")).toBe(mine);
    expect(isPersonalVault(getVaultPaths(mine), "session-f")).toBe(true);
    // Without a session, the personal root is still the user's own.
    expect(getPersonalWikiRoot()).toBe(join(tmpDir, "home6"));
    expect(isPersonalVault(getVaultPaths(mine))).toBe(false);
  });

  it("still honors the pin and the ancestor walk underneath it", () => {
    // Regression guard for the claim that this is additive: with the variable
    // unset and no id offered, the documented order is intact.
    const root = makeVault(join(tmpDir, "mono"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    expect(resolveProjectVaultRoot(nested, "no-such-session")).toBe(root);
    expect(resolveVaultRoot(nested, "no-such-session")).toBe(root);
  });
});

describe("ctxSessionId", () => {
  it("reads the id pi offers on the handler context", () => {
    expect(ctxSessionId({ sessionManager: { getSessionId: () => "ctx-session" } })).toBe(
      "ctx-session",
    );
  });

  it("gives up quietly on a context with no session manager", () => {
    // Every caller treats undefined as "no session pin, use the process rules",
    // so a throw here would surface as a failed wiki tool rather than as a
    // fallback.
    expect(ctxSessionId(undefined)).toBeUndefined();
    expect(ctxSessionId({})).toBeUndefined();
    expect(ctxSessionId({ sessionManager: {} })).toBeUndefined();
    expect(ctxSessionId({ sessionManager: { getSessionId: null } })).toBeUndefined();
    expect(ctxSessionId({ sessionManager: { getSessionId: () => "" } })).toBeUndefined();
    expect(
      ctxSessionId({
        sessionManager: {
          getSessionId: () => {
            throw new Error("session gone");
          },
        },
      }),
    ).toBeUndefined();
  });
});
