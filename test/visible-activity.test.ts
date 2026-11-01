import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODEL_STATUS_KEY } from "../extensions/llm-wiki/lib/model-command.js";
import { buildReminderText, buildSessionNotice } from "../extensions/llm-wiki/lib/observation.js";
import { Runtime } from "../extensions/llm-wiki/lib/runtime.js";
import {
  loadTaskConfig,
  noticesEnabled,
  statusBadgeEnabled,
  statusModelEnabled,
} from "../extensions/llm-wiki/lib/task-config.js";
import { applySessionStartStatus } from "../extensions/llm-wiki/lib/visible-status.js";

// Issue #77: make wiki activity visible (recall status, observe/retro reminder,
// session notice) and route mutating actions through background + report.

describe("noticesEnabled (issue #77)", () => {
  it("defaults to true when unset", () => {
    expect(noticesEnabled(undefined)).toBe(true);
    expect(noticesEnabled({})).toBe(true);
  });

  it("honors an explicit boolean", () => {
    expect(noticesEnabled({ notices: false })).toBe(false);
    expect(noticesEnabled({ notices: true })).toBe(true);
  });
});

describe("loadTaskConfig parses notices", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `notices-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("reads notices:false from project settings", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { notices: false } }),
    );
    expect(loadTaskConfig(tmpDir).notices).toBe(false);
    expect(noticesEnabled(loadTaskConfig(tmpDir))).toBe(false);
  });

  it("ignores a non-boolean notices value", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { notices: "yes" } }),
    );
    expect(loadTaskConfig(tmpDir).notices).toBeUndefined();
  });
});

describe("visible guidance text", () => {
  it("reminder mentions BOTH capture tools", () => {
    const t = buildReminderText();
    expect(t).toContain("wiki_observe");
    expect(t).toContain("wiki_retro");
  });

  it("session notice announces the full loop (recall -> search -> read -> observe -> retro)", () => {
    const n = buildSessionNotice();
    expect(n).toContain("recall");
    expect(n).toContain("wiki_search");
    expect(n).toContain("read");
    expect(n).toContain("wiki_observe");
    expect(n).toContain("wiki_retro");
    // documents the opt-out
    expect(n).toContain("notices");
  });
});

interface SentMessage {
  msg: { customType: string; content: string; display: boolean };
}

function fakePi(): { pi: ExtensionAPI; sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  const pi = {
    sendMessage: (msg: SentMessage["msg"]) => {
      sent.push({ msg });
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

describe("Runtime.report (issue #77)", () => {
  it("no-ops when no pi is attached", () => {
    const rt = new Runtime();
    expect(() => rt.report("hello")).not.toThrow();
  });

  it("emits a visible message when notices are enabled (default)", () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    rt.report("done");
    expect(sent).toHaveLength(1);
    expect(sent[0].msg.customType).toBe("wiki-action-report");
    expect(sent[0].msg.content).toBe("done");
    expect(sent[0].msg.display).toBe(true);
  });

  it("injects silently (display:false) when notices are disabled", () => {
    const rt = new Runtime();
    rt.config = { notices: false };
    const { pi, sent } = fakePi();
    rt.pi = pi;
    rt.report("quiet");
    expect(sent[0].msg.display).toBe(false);
  });

  it("never throws if sendMessage throws", () => {
    const rt = new Runtime();
    rt.pi = {
      sendMessage: () => {
        throw new Error("torn down");
      },
    } as unknown as ExtensionAPI;
    expect(() => rt.report("boom")).not.toThrow();
  });

  it("skips empty summaries", () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    rt.report("");
    expect(sent).toHaveLength(0);
  });
});

describe("Runtime.launchReported (issue #77)", () => {
  it("runs the work and reports its returned summary", async () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    let ran = false;
    await rt.launchReported({ hasUI: false }, "label-a", async () => {
      ran = true;
      return "✅ work complete";
    });
    expect(ran).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg.content).toBe("✅ work complete");
  });

  it("does not report when work returns null", async () => {
    const rt = new Runtime();
    const { pi, sent } = fakePi();
    rt.pi = pi;
    await rt.launchReported({ hasUI: false }, "label-b", async () => null);
    expect(sent).toHaveLength(0);
  });
});

// ─── applySessionStartStatus ───────────────────────────────────────────────
//
// The two `setStatus` calls made at session start each answer to one setting,
// the `🧠 LLM Wiki (…)` badge to `statusBadge` and the `🧠 wiki model: …` line to
// `statusModel`.  `notices` governs the transcript and is not read here.  A
// rejected line is still passed to `setStatus`, as `undefined`, since the slot
// may already hold text.

interface StatusCall {
  key: string;
  /** `undefined` is a clear, which is what a disabled line emits. */
  value: string | undefined;
}

function fakeUi(): {
  ui: { setStatus: (k: string, v: string | undefined) => void };
  calls: StatusCall[];
} {
  const calls: StatusCall[] = [];
  return {
    ui: { setStatus: (key, value) => calls.push({ key, value }) },
    calls,
  };
}

describe("applySessionStartStatus (per-line status gating)", () => {
  it("sets BOTH status lines on an empty config — default-on contract", () => {
    const rt = new Runtime();
    // rt.config is `{}` by default — same shape as before ensureConfig runs.
    // Both resolvers default to true, so an empty config emits both lines.
    // This is the case that nudged the original #83 author toward an
    // "ensureConfig was empty" theory; the test pins down that empty-config
    // is default-ON and therefore non-silencing.
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      key: "llm-wiki",
      value: "🧠 LLM Wiki (13 tools, observe + recall active)",
    });
    expect(calls[1]).toEqual({
      key: MODEL_STATUS_KEY,
      value: "🧠 wiki model: session model (anthropic-sonnet-4)",
    });
  });

  it("sets BOTH status lines when notices: true is explicit", () => {
    const rt = new Runtime();
    rt.config = { notices: true };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: undefined,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].key).toBe("llm-wiki");
    expect(calls[1].key).toBe(MODEL_STATUS_KEY);
  });

  it("emits the 16-tools label when trajectoriesOn is true", () => {
    const rt = new Runtime();
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: true,
      sessionModelId: undefined,
    });
    expect(calls[0].value).toBe("🧠 LLM Wiki (16 tools, trajectory + observe + recall active)");
  });

  // Neither footer line reads `notices`, so switching it changes nothing here.

  it("writes both status lines when notices: false", () => {
    const rt = new Runtime();
    rt.config = { notices: false };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls).toHaveLength(2);
  });

  it("still chooses the badge's tools-active label from trajectoriesOn when notices: false", () => {
    const rt = new Runtime();
    rt.config = { notices: false };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: true,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls[0]).toEqual({
      key: "llm-wiki",
      value: "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)",
    });
  });

  it("uses the configured taskModel label when one is set", () => {
    const rt = new Runtime();
    rt.config = { taskModel: { provider: "anthropic", id: "claude-sonnet-4" } };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: "some-other-session-id",
    });
    // taskModel wins over the session model id (see formatActiveModelLabel).
    expect(calls[1]).toEqual({
      key: MODEL_STATUS_KEY,
      value: "🧠 wiki model: anthropic/claude-sonnet-4",
    });
  });

  // Each setting hides its own line and leaves the other one.

  it("clears only the badge when statusBadge: false, leaving the model line set", () => {
    const rt = new Runtime();
    rt.config = { statusBadge: false };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls).toEqual([
      { key: "llm-wiki", value: undefined },
      { key: MODEL_STATUS_KEY, value: "🧠 wiki model: session model (anthropic-sonnet-4)" },
    ]);
  });

  it("clears only the model line when statusModel: false, leaving the badge set", () => {
    const rt = new Runtime();
    rt.config = { statusModel: false };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls).toEqual([
      { key: "llm-wiki", value: "🧠 LLM Wiki (13 tools, observe + recall active)" },
      { key: MODEL_STATUS_KEY, value: undefined },
    ]);
  });

  it("clears both lines when both are false and notices is on", () => {
    const rt = new Runtime();
    rt.config = { notices: true, statusBadge: false, statusModel: false };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: true,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls).toEqual([
      { key: "llm-wiki", value: undefined },
      { key: MODEL_STATUS_KEY, value: undefined },
    ]);
  });

  // A hidden line stays hidden with `notices` off as well.
  it("clears the badge even with notices: false, and still sets the model line", () => {
    const rt = new Runtime();
    rt.config = { notices: false, statusBadge: false };
    const { ui, calls } = fakeUi();
    applySessionStartStatus({
      ui,
      runtime: rt,
      trajectoriesOn: false,
      sessionModelId: "anthropic-sonnet-4",
    });
    expect(calls).toEqual([
      { key: "llm-wiki", value: undefined },
      { key: MODEL_STATUS_KEY, value: "🧠 wiki model: session model (anthropic-sonnet-4)" },
    ]);
  });
});

describe("statusBadgeEnabled / statusModelEnabled (footer opt-outs)", () => {
  it("default to true when unset", () => {
    expect(statusBadgeEnabled(undefined)).toBe(true);
    expect(statusBadgeEnabled({})).toBe(true);
    expect(statusModelEnabled(undefined)).toBe(true);
    expect(statusModelEnabled({})).toBe(true);
  });

  it("honor an explicit boolean", () => {
    expect(statusBadgeEnabled({ statusBadge: false })).toBe(false);
    expect(statusBadgeEnabled({ statusBadge: true })).toBe(true);
    expect(statusModelEnabled({ statusModel: false })).toBe(false);
    expect(statusModelEnabled({ statusModel: true })).toBe(true);
  });

  it("answer independently of each other", () => {
    expect(statusBadgeEnabled({ statusBadge: false, statusModel: true })).toBe(false);
    expect(statusModelEnabled({ statusBadge: false, statusModel: true })).toBe(true);
  });
});

describe("loadTaskConfig parses the per-line status settings", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(import.meta.dirname, "..", "tmp", `status-${Date.now()}-${Math.random()}`);
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("reads both from project settings", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { statusBadge: false, statusModel: false } }),
    );
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.statusBadge).toBe(false);
    expect(cfg.statusModel).toBe(false);
    // The transcript setting keeps its default.
    expect(noticesEnabled(cfg)).toBe(true);
  });

  it("ignores non-boolean values", () => {
    writeFileSync(
      join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ "llm-wiki": { statusBadge: "no", statusModel: 0 } }),
    );
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.statusBadge).toBeUndefined();
    expect(cfg.statusModel).toBeUndefined();
  });
});

// Sanity: the vault structure helper is unrelated, but assert the new test file
// does not accidentally create a vault in cwd.
describe("no side effects", () => {
  it("does not create a vault in the repo root", () => {
    expect(existsSync(join(import.meta.dirname, "..", ".llm-wiki"))).toBe(false);
  });
});
