import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { FakeGitHub } from "../github/fake-github.ts";
import { sendDueReplies } from "../github/outbox.ts";
import type { ProcessRunner } from "../process.ts";
import { routeFollowUps } from "../worker/follow-up.ts";
import { FakeRunner } from "../worker/fake-runner.ts";
import { BUDGET_RESUME_PROMPT, CHECKPOINT_PROMPT, Workers } from "../worker/workers.ts";
import { RECOVERY_PROMPT, RETRY_PROMPT } from "./stuck.ts";
import { Store } from "../store/store.ts";
import { parseSemonStalls, semonStallsArgs, watchdog, type WatchdogOptions } from "./watchdog.ts";

const REPO = "onsager-ai/ostrom";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const MINUTES = 20;
const semonFixture = () => readFileSync(new URL("./fixtures/semon-stalls.json", import.meta.url), "utf8");
const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

const semonStall = (branch: string | null, reason = "waiting-question", question: string | null = "Which colour?") => ({
  id: `session-${branch?.split("-").at(-1)}`,
  harness: "claude",
  branch,
  state: reason,
  stall_reason: reason,
  idle_ms: 1_800_000,
  open_question: question === null ? null : { text: question, asked_at: 1, handoff: null },
});

function setup() {
  let now = NOW;
  const store = Store.open(":memory:", { now: () => now });
  const runner = new FakeRunner();
  const workers = new Workers({
    store, runners: { claude: runner, codex: runner },
    config: { repo: "/repo", base: "main", worktrees: "/wt", harness: "codex", model: "gpt-6-luna", machine: "host" },
  });
  const source = store.ensureSource("github", REPO);
  const issue = store.ensureThread({ sourceId: source.id, kind: "issue", number: 7, url: `https://github.com/${REPO}/issues/7` });
  const startWorker = (n: number) => {
    const trigger = store.insertTrigger({
      sourceId: source.id, sourceEventId: `IC_${n}`, threadId: issue, kind: "issue_comment", actor: "alice",
      url: `https://github.com/${REPO}/issues/7#issuecomment-${n}`, occurredAt: NOW,
    }).id;
    const { ticketId } = store.recordDecision({ threadId: issue, triggerIds: [trigger], verdict: "accept", reason: "fix it" });
    const assignmentId = store.createAssignment(ticketId!);
    store.configureNativeAssignment(assignmentId, {
      harness: "codex", model: "gpt-6-luna", worktree: `/wt/${assignmentId}`,
      branch: `ostrom/ticket-${ticketId}-${assignmentId}`, machine: "host",
    });
    store.startNativeAssignment(assignmentId, `session-${n}`);
    return { ticketId: ticketId!, assignmentId, branch: `ostrom/ticket-${ticketId}-${assignmentId}` };
  };
  let semonStalls: unknown[] = [];
  const semon: ProcessRunner = async ({ args }) => {
    assert.deepEqual(args, semonStallsArgs(MINUTES));
    return ok({ now: 1, idle_minutes: MINUTES, rule: "…", stalls: semonStalls, window_start: 0 });
  };
  const options = (): WatchdogOptions => ({ store, semon, idleMinutes: MINUTES, workers, now });
  const followUp = () => store.insertTrigger({ sourceId: source.id, sourceEventId: "unblock", threadId: issue,
    kind: "issue_comment", actor: "alice", url: `https://github.com/${REPO}/issues/7#issuecomment-99`, occurredAt: now }).id;
  return { store, runner, workers, startWorker, followUp, options, advance: (ms: number) => (now = new Date(now.getTime() + ms)), setSemon: (stalls: unknown[]) => (semonStalls = stalls) };
}

test("Semon's captured stalls output parses to the fields the Watchdog reads", () => {
  const stalls = parseSemonStalls(semonFixture(), 2);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]!.branch, "ostrom/ticket-1-1");
  assert.equal(stalls[0]!.stallReason, "waiting-question");
});

test("Semon's output is read strictly", () => {
  const value = JSON.parse(semonFixture());
  assert.throws(() => parseSemonStalls(semonFixture(), 20), /idle_minutes: expected 20/);
  assert.throws(() => parseSemonStalls("semon: oops", 2), /not JSON/);
  delete value.stalls[0].stall_reason;
  assert.throws(() => parseSemonStalls(JSON.stringify(value), 2), /stall_reason: expected a string/);
});

test("two silent recovery turns on the retained session lead to one blocking reply", async () => {
  const s = setup();
  const a = s.startWorker(1);
  s.setSemon([semonStall("someone/else"), { ...semonStall(a.branch), id: "different-session" }, semonStall(a.branch)]);
  const check = () => watchdog(s.options());
  assert.equal((await check()).checked[0]!.newEpisode, true);
  await s.workers.drain();
  assert.equal(s.store.getStall(1).detail, "Which colour?");
  assert.deepEqual(s.runner.sessions[0]?.prompts, [RECOVERY_PROMPT]);
  assert.equal(s.runner.sessions[0]?.id, "session-1");
  assert.equal(s.store.hasReply("stall-1"), false);

  s.setSemon([]);
  assert.equal((await check()).checked[0]!.clearedStallId, null);
  s.advance(30 * 60_000);
  s.setSemon([semonStall(a.branch)]);
  s.runner.sessions[0]!.reply = () => "invalid template";
  assert.equal((await check()).checked[0]!.newEpisode, false);
  await s.workers.drain();
  assert.deepEqual(s.runner.sessions[0]?.prompts, [RECOVERY_PROMPT, RETRY_PROMPT]);
  assert.equal(s.store.hasReply("stall-1"), false);

  s.advance(30 * 60_000);
  await check();
  await check();
  const replies = s.store.dueReplies().filter((reply) => reply.id.startsWith("stall-"));
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.blocking, true);
  assert.match(replies[0]!.body, /Attempted to recover twice on the same session/);
  assert.equal(s.store.getTicket(a.ticketId).state, "open");
  const github = new FakeGitHub(() => s.options().now!);
  github.issue(7);
  const send = () => sendDueReplies({ store: s.store, gh: github.gh, repo: REPO });
  assert.ok((await send()).sent.includes("stall-1"));
  assert.ok(!(await send()).sent.includes("stall-1"));
  assert.equal(github.commentsOn(7).filter((comment) => String(comment["body"]).includes("ostrom:reply id=stall-1")).length, 1);
  s.setSemon([]);
  assert.equal((await check()).checked[0]!.clearedStallId, null);
  s.followUp();
  routeFollowUps(s.store, s.workers);
  await s.workers.drain();
  assert.equal(s.store.openStall(a.assignmentId), null);
  assert.equal(s.store.dueReplies().some((reply) => reply.id === "stall-1"), false);
  assert.equal(s.runner.sessions.length, 1);
});

test("an unreadable Semon read keeps the episode, then a settled clean read clears it", async () => {
  const s = setup();
  const a = s.startWorker(1);
  s.setSemon([semonStall(a.branch)]);
  await watchdog(s.options());
  await s.workers.drain();
  s.advance(30 * 60_000);
  const options = s.options();
  const pass = await watchdog({ ...options, semon: async () => ({ code: 1, stdout: "", stderr: "no logs" }) });
  assert.deepEqual(pass.failed, [{ what: "semon stalls", error: "semon query stalls exited 1: no logs" }]);
  assert.equal(s.store.getStall(1).clearedAt, null);
  s.setSemon([]);
  assert.equal((await watchdog(s.options())).checked[0]!.clearedStallId, 1);
});

test("the Watchdog checkpoints once and resumes the same Worker after extension", async () => {
  const s = setup();
  const a = s.startWorker(1);
  s.store.beginTurn(a.assignmentId);
  s.store.endTurn(a.assignmentId, { inputTokens: 1_900_000, cachedInputTokens: 100_000, outputTokens: 10 });
  await watchdog(s.options());
  await s.workers.drain();
  await watchdog(s.options());
  assert.deepEqual(s.runner.sessions[0]?.prompts, [CHECKPOINT_PROMPT]);
  assert.equal(s.store.getTicket(a.ticketId).budgetPause, "tokens");
  assert.equal(s.store.budgetUsage(a.ticketId).tokens, 2_000_027);
  s.store.extendBudget(a.ticketId, { tokens: 1000 });
  await watchdog(s.options());
  await s.workers.drain();
  assert.deepEqual(s.runner.sessions[0]?.prompts, [CHECKPOINT_PROMPT, BUDGET_RESUME_PROMPT]);
  assert.equal(s.store.getTicket(a.ticketId).state, "open");
  assert.equal(s.store.getTicket(a.ticketId).budgetResume, false);
  assert.equal(s.runner.sessions.length, 1);
});


test("an active turn reaches the idle budget and yields to one checkpoint", async () => {
  const s = setup();
  const a = s.startWorker(1);
  s.runner.hold = true;
  const started = new Promise<void>((resolve) => s.workers.deliver(a.assignmentId, "active", "continue", () => resolve()));
  await started;
  s.advance(30 * 60_000);
  s.setSemon([semonStall(a.branch, "no-output", null)]);
  const session = s.runner.sessions[0]!;
  session.auto = true;
  await watchdog(s.options());
  await s.workers.drain();
  assert.deepEqual(session.prompts, ["continue", CHECKPOINT_PROMPT]);
  assert.equal(session.maxRunning, 1);
  assert.equal(s.store.getTicket(a.ticketId).budgetPause, "idleMs");
  assert.equal(s.store.openStall(a.assignmentId), null);
});

test("a stuck recovery turn can itself be interrupted for the second attempt", async () => {
  const s = setup();
  const a = s.startWorker(1);
  s.runner.hold = true;
  s.setSemon([semonStall(a.branch)]);
  await watchdog(s.options());
  // Let the queued recovery call the SDK while keeping its turn open.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const session = s.runner.sessions[0]!;
  assert.deepEqual(session.prompts, [RECOVERY_PROMPT]);
  session.auto = true;
  s.advance(20 * 60_000);
  s.setSemon([{ ...semonStall(a.branch, "no-output", null), idle_ms: 20 * 60_000 }]);
  await watchdog(s.options());
  await s.workers.drain();
  assert.deepEqual(session.prompts, [RECOVERY_PROMPT, RETRY_PROMPT]);
  assert.equal(session.maxRunning, 1);
  assert.equal(s.store.getStall(1).attempts, 2);
});
