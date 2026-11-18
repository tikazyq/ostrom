import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Store } from "../store/store.ts";
import { renderMergePreview } from "./merge-preview.ts";
import type { GhRunner } from "./gh.ts";

const now = new Date("2026-11-10T12:00:00Z");
function setup() {
  const store = Store.open(":memory:", { now: () => now });
  const f = JSON.parse(readFileSync(new URL("./fixtures/merge-evidence.json", import.meta.url), "utf8"));
  const source = store.ensureSource("github", f.repo);
  const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: 1, url: "issue" });
  const triggerId = store.insertTrigger({ sourceId: source.id, threadId, sourceEventId: "event", kind: "issue_comment", actor: "a", url: "comment", occurredAt: now }).id;
  const ticketId = store.recordDecision({ threadId, triggerIds: [triggerId], verdict: "accept", reason: "work" }).ticketId!;
  const assignment = store.createAssignment(ticketId);
  store.configureNativeAssignment(assignment, {
    harness: "codex", model: "test", worktree: "/tmp/worktree", branch: "ostrom/ticket-1-1", machine: "test",
  });
  store.startNativeAssignment(assignment, "session");
  const calls: (readonly string[])[] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === "graphql") return JSON.stringify(f.graph);
    assert.equal(args[2], "GET");
    const path = args.at(-1)!;
    if (path.includes("/pulls?")) return JSON.stringify([{ number: 12 }]);
    if (path.endsWith("/pulls/12")) return JSON.stringify(f.pr);
    if (path.endsWith("/protection")) return JSON.stringify(f.protection);
    if (path.includes("/rules/branches/")) return JSON.stringify(f.rules);
    if (path.includes("/reviews?")) return JSON.stringify(f.reviews);
    if (path === `repos/${f.repo}`) return JSON.stringify(f.repository);
    throw new Error(`unexpected request ${path}`);
  };
  return { store, gh, calls, f, ticketId };
}

test("merge preview reports untracked prerequisites and performs no state writes", async () => {
  const { store, gh, f, ticketId } = setup();
  try {
    const before = store.operatorTicket(ticketId);
    const report = await renderMergePreview(store, gh, f.repo, "main", { strategy: "unattended" }, now);
    assert.match(report, /GitHub evidence passes/);
    for (const state of ["Issue state", "Stop state", "Quiet window", "Idle state"]) assert.ok(report.includes(`${state}: not yet tracked`));
    assert.match(report, /Ticket: open/);
    assert.match(report, /Budget: within limits/);
    assert.deepEqual(store.operatorTicket(ticketId), before);
  } finally { store.close(); }
});

test("merge preview uses current ticket pause and instant budget state", async () => {
  const { store, gh, f, ticketId } = setup();
  try {
    store.pauseTicket(ticketId);
    const report = await renderMergePreview(store, gh, f.repo, "main", { strategy: "unattended" }, new Date(now.getTime() + 480 * 60_000));
    assert.match(report, /ticket is paused/);
    assert.match(report, /time budget limit reached/);
  } finally { store.close(); }
});

test("merge preview blocks unreadable evidence and ambiguous PR ownership", async () => {
  const { store, f } = setup();
  try {
    const failed = await renderMergePreview(store, async () => { throw new Error("denied"); }, f.repo, "main", { strategy: "unattended" }, now);
    assert.match(failed, /evidence unreadable: denied/);
    const ambiguous = await renderMergePreview(store, async () => JSON.stringify([{ number: 12 }, { number: 13 }]), f.repo, "main", { strategy: "unattended" }, now);
    assert.match(ambiguous, /2 open PRs/);
  } finally { store.close(); }
});
