import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Store } from "../store/store.ts";
import { queueStatusCard } from "./cards.ts";
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

for (const state of ["waiting_for_human_merge", "waiting_to_merge"] as const) {
  test(`status card snapshot: ${state}`, async () => {
    assert.equal(renderStatusCard({ ...base, state, mergeWait: {
      policy: state === "waiting_for_human_merge" ? "human" : "unattended",
      headSha: "abc123", blockingReason: state === "waiting_for_human_merge" ? "human merge required" : null,
      earliestMergeAt: state === "waiting_to_merge" ? "2026-11-09T12:28:00Z" : null,
    } }), await snapshot(state));
  });
}

test("status card snapshot: budget warning and budget pause", async () => {
  assert.equal(
    renderStatusCard({ ...base, state: "paused", budgetWarning: "tokens", pauseCause: "budget reached: tokens" }),
    await budgetSnapshot(),
  );
});

test("cards derive merge waiting from its durable snapshot and clear it for owed work", () => {
  const store = Store.open(":memory:", { now: () => base.now });
  try {
    const source = store.ensureSource("github", "onsager-ai/ostrom");
    const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: 7, url: "https://example.test/7" });
    const triggerId = store.insertTrigger({ sourceId: source.id, threadId, sourceEventId: "accept", kind: "issue_comment",
      actor: "alice", url: "https://example.test/comment", occurredAt: base.now }).id;
    const ticketId = store.recordDecision({ threadId, triggerIds: [triggerId], verdict: "accept", reason: "work" }).ticketId!;
    const assignmentId = store.createAssignment(ticketId);
    store.configureNativeAssignment(assignmentId, { harness: "codex", model: "m", worktree: "/w", branch: "b", machine: "h" });
    store.startNativeAssignment(assignmentId, "session");
    store.setMergeWaitCard(assignmentId, { state: "waiting_to_merge", policy: "unattended", headSha: "abc123",
      blockingReason: "waiting for checks", earliestMergeAt: null });
    queueStatusCard(store, ticketId, base.now);
    assert.match(store.pendingReplies()[0]!.body, /Ostrom: Waiting to merge/);
    assert.match(store.pendingReplies()[0]!.body, /Waiting: waiting for checks/);
    store.queueTurn(assignmentId, "followup", "revise", {});
    queueStatusCard(store, ticketId, base.now);
    assert.match(store.pendingReplies()[0]!.body, /Ostrom: Working/);
    assert.doesNotMatch(store.pendingReplies()[0]!.body, /Merge policy:/);
  } finally {
    store.close();
  }
});

async function snapshot(state: StatusCardState): Promise<string> {
  return readFile(new URL(`./__snapshots__/status-card-${state}.md`, import.meta.url), "utf8");
}

async function budgetSnapshot(): Promise<string> {
  return readFile(new URL("./__snapshots__/status-card-budget-paused.md", import.meta.url), "utf8");
}
