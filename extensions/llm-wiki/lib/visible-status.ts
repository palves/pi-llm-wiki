import { formatActiveModelLabel, MODEL_STATUS_KEY } from "./model-command.js";
import type { Runtime } from "./runtime.js";
import { statusBadgeEnabled, statusModelEnabled } from "./task-config.js";

/**
 * Minimal sink for the two status keys this helper writes. Mirrors the slice
 * of `ctx.ui` the extension uses; kept narrow so tests don't need to fake the
 * whole pi UI surface.  A value of `undefined` clears the slot.
 */
export interface StatusSink {
  setStatus(key: string, value: string | undefined): void;
}

/**
 * Write the two footer status lines for the current session:
 *
 *   1. `🧠 LLM Wiki (… tools, … active)`     — the "wiki is loaded" badge
 *   2. `🧠 wiki model: <label>`              — the active background task model
 *
 * The badge is written when `llm-wiki.statusBadge` allows it and the model line
 * when `llm-wiki.statusModel` does, both defaulting to `true`.  `notices`
 * governs the transcript and is not read here.
 *
 * `statusBadge` decides what occupies the `llm-wiki` slot.  The recall-count
 * rewrite in `index.ts` writes that same slot, so it checks the setting too.
 *
 * A line whose setting is off gets setStatus(key, undefined), pi's clear,
 * instead of no call at all.  `/wiki-settings` re-runs this after a toggle, and
 * the text written at session start stays on the footer until something removes
 * it.
 *
 * The helper lives apart from `index.ts` so the gating is testable without
 * faking the extension factory.  See `test/visible-activity.test.ts`.  Pure
 * modulo `ui.setStatus`.  Callers MUST run `runtime.ensureConfig(...)` for the
 * current cwd first, so the resolvers see the loaded project settings.
 */
export function applySessionStartStatus(opts: {
  ui: StatusSink;
  runtime: Runtime;
  trajectoriesOn: boolean;
  sessionModelId: string | undefined;
}): void {
  if (statusBadgeEnabled(opts.runtime.config)) {
    opts.ui.setStatus(
      "llm-wiki",
      opts.trajectoriesOn
        ? "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)"
        : "🧠 LLM Wiki (13 tools, observe + recall active)",
    );
  } else {
    opts.ui.setStatus("llm-wiki", undefined);
  }

  if (statusModelEnabled(opts.runtime.config)) {
    const modelLabel = formatActiveModelLabel(opts.runtime.config, opts.sessionModelId);
    opts.ui.setStatus(MODEL_STATUS_KEY, `🧠 wiki model: ${modelLabel}`);
  } else {
    opts.ui.setStatus(MODEL_STATUS_KEY, undefined);
  }
}
