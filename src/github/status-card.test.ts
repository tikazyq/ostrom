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

for (const state of ["working", "recovering", "paused", "stuck", "done", "stopped"] as const) {
  test(`status card snapshot: ${state}`, async () => {
    assert.equal(renderStatusCard({ ...base, state }), await snapshot(state));
  });
}

test("status card snapshot: waiting for a human merge", async () => {
  const state = "waiting-for-human-merge";
  assert.equal(renderStatusCard({ ...base, state, mergeWait: { policy: "human", headSha: "abc123" } }), await snapshot(state));
});

test("status card snapshot: waiting to merge", async () => {
  const state = "waiting-to-merge";
  assert.equal(renderStatusCard({
    ...base, state, mergeWait: { policy: "unattended", headSha: "abc123", quietDeadline: "2026-11-09T12:28:00Z" },
  }), await snapshot(state));
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
