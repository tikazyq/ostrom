import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderStatusCard, type StatusCard, type StatusCardState } from "./status-card.ts";

const base: Omit<StatusCard, "state"> = {
  plan: ["Inspect the failure", "Patch and verify the fix"],
  pullRequest: "https://github.com/onsager-ai/ostrom/pull/42",
  harness: "codex",
  model: "gpt-6-luna",
  modelReason: "Cheapest capable model for this task.",
  effort: "low",
  effortReason: "Small documentation change.",
  lastActivityAt: new Date("2026-11-09T12:13:00Z"),
  now: new Date("2026-11-09T12:18:59Z"),
  markerId: "card-thread-7",
};

for (const state of ["working", "recovering", "paused", "stuck", "waiting_to_merge", "waiting_for_human_merge", "done", "stopped"] as const) {
  test(`status card snapshot: ${state}`, async () => {
    assert.equal(renderStatusCard({ ...base, state }), await snapshot(state));
  });
}

test("status card distinguishes the current model from a next-session override", () => {
  const rendered = renderStatusCard({ ...base, state: "working", nextModel: "`codex/sol` — Model override by operator." });
  assert.match(rendered, /Model: `gpt-6-luna`/);
  assert.match(rendered, /Next session model: `codex\/sol`/);
});

test("status card shows stale approvals instead of approval satisfaction", () => {
  const rendered = renderStatusCard({ ...base, state: "waiting_to_merge", mergeStatus: "policy approvals; head 53975b6; Approved on 0e65021; the head is now 53975b6. Approve again to merge." });
  assert.ok(rendered.includes("Approved on 0e65021; the head is now 53975b6. Approve again to merge."));
  assert.doesNotMatch(rendered, /Approved, waiting to merge/);
});

test("status card snapshot: paused while waiting for a human merge", async () => {
  assert.equal(
    renderStatusCard({ ...base, state: "paused", mergeStatus: "policy human; head abc123; waiting for a human merge" }),
    await readFile(new URL("./__snapshots__/status-card-paused-human-merge.md", import.meta.url), "utf8"),
  );
});

test("status card snapshot: budget warning and budget pause", async () => {
  assert.equal(
    renderStatusCard({ ...base, state: "paused", budgetWarning: "tokens", pauseCause: "budget reached: tokens" }),
    await budgetSnapshot(),
  );
});

async function snapshot(state: StatusCardState): Promise<string> {
  return readFile(new URL(`./__snapshots__/status-card-${state}.md`, import.meta.url), "utf8");
}

async function budgetSnapshot(): Promise<string> {
  return readFile(new URL("./__snapshots__/status-card-budget-paused.md", import.meta.url), "utf8");
}
