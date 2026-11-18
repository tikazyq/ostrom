import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderStatusCard, type StatusCard, type StatusCardState } from "./status-card.ts";

const base: Omit<StatusCard, "state"> = {
  plan: ["Inspect the failure", "Patch and verify the fix"],
  pullRequest: "https://github.com/onsager-ai/ostrom/pull/42",
  harness: "codex",
  model: "gpt-6-luna",
  lastActivityAt: new Date("2026-11-09T12:13:00Z"),
  now: new Date("2026-11-09T12:18:59Z"),
  markerId: "card-thread-7",
};

for (const state of ["working", "paused", "recovering", "stuck", "done", "stopped"] as const) {
  test(`status card snapshot: ${state}`, async () => {
    assert.equal(renderStatusCard({ ...base, state }), await snapshot(state));
  });
}

async function snapshot(state: StatusCardState | "budget-paused"): Promise<string> {
  return readFile(new URL(`./__snapshots__/status-card-${state}.md`, import.meta.url), "utf8");
}

test("budget-paused status card snapshot", async () => {
  assert.equal(renderStatusCard({ ...base, state: "paused", budgetPause: "tokens" }), await snapshot("budget-paused"));
});

test("an open ticket can show budget warnings", () => {
  assert.match(renderStatusCard({ ...base, state: "working", budgetWarning: ["wallMs", "turns"] }), /Budget warning: nearing the limit for wall time, turns/);
});
