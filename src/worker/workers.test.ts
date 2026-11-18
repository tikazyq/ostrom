import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { Store } from "../store/store.ts";
import { FakeRunner } from "./fake-runner.ts";
import { workerBrief } from "./dispatch.ts";
import { gitDirs, INTERRUPTED_PROMPT, Workers, type WorkersDeps } from "./workers.ts";

const REPO = "onsager-ai/ostrom";
const config = { repo: "/repo", base: "main", worktrees: "/wt", harness: "codex" as const, model: "gpt-6-luna", machine: "host" };
const stores: Store[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
});

function fixture(extra: Partial<WorkersDeps> = {}, harness: "claude" | "codex" = "codex") {
  const store = Store.open(":memory:", { now: () => new Date("2026-11-09T12:00:00.000Z") });
  stores.push(store);
  const source = store.ensureSource("github", REPO);
  const issue = store.ensureThread({ sourceId: source.id, kind: "issue", number: 7, url: `https://github.com/${REPO}/issues/7` });
  const trigger = store.insertTrigger({
    sourceId: source.id, sourceEventId: "IC_1", threadId: issue, kind: "issue_comment", actor: "alice",
    url: `https://github.com/${REPO}/issues/7#issuecomment-1`, occurredAt: new Date("2026-11-09T11:59:00.000Z"),
  }).id;
  const { ticketId } = store.recordDecision({ threadId: issue, triggerIds: [trigger], verdict: "accept", reason: "fix the README typo" });
  const runner = new FakeRunner();
  const worktrees: string[][] = [];
  const addWorktree: WorkersDeps["addWorktree"] = async (repo, path, base, ticket, assignment) => {
    worktrees.push([repo, path, base]);
    return `ostrom/ticket-${ticket}-${assignment}`;
  };
  const make = () => new Workers({ store, config: { ...config, harness }, runners: { claude: runner, codex: runner }, addWorktree, ...extra });
  return { store, runner, worktrees, ticketId: ticketId!, workers: make(), make };
}

test("dispatch makes the worktree, starts the session with the brief and stores its id", async () => {
  const { store, runner, worktrees, ticketId, workers } = fixture();
  runner.hold = true;
  const dispatched = await workers.dispatch(ticketId);
  assert.deepEqual(dispatched, { assignmentId: 1, sessionId: "sess-1", branch: `ostrom/ticket-${ticketId}-1` });
  assert.deepEqual(worktrees, [["/repo", `/wt/ticket-${ticketId}-1`, "main"]]);
  const a = store.getAssignment(1);
  assert.deepEqual(
    [a.state, a.harness, a.model, a.sessionId, a.worktree, a.branch, a.machine, a.turns],
    ["running", "codex", "gpt-6-luna", "sess-1", `/wt/ticket-${ticketId}-1`, dispatched.branch, "host", 1],
  );
  assert.notEqual(a.turnStartedAt, null, "the first turn is still running");
  const session = runner.sessions[0]!;
  assert.equal(session.options.cwd, `/wt/ticket-${ticketId}-1`);
  assert.equal(session.options.model, "gpt-6-luna");
  assert.deepEqual(session.options.writableDirs, [
    "/repo/.git/objects",
    "/repo/.git/refs",
    "/repo/.git/logs",
    `/repo/.git/worktrees/ticket-${ticketId}-1`,
  ]);
  assert.deepEqual(session.prompts, [workerBrief(store.ticketContext(ticketId), dispatched.branch, "main")]);

  session.release();
  await workers.drain();
  const done = store.getAssignment(1);
  assert.deepEqual([done.turnStartedAt, done.inputTokens, done.cachedInputTokens, done.outputTokens, done.outcome], [null, 10, 5, 2, null]);
});

test("linked worktrees grant only the Git paths a commit changes", () => {
  assert.deepEqual(gitDirs("/repo", "/workers/ticket-12-34"), [
    "/repo/.git/objects",
    "/repo/.git/refs",
    "/repo/.git/logs",
    "/repo/.git/worktrees/ticket-12-34",
  ]);
});

test("cancelling an in-flight turn lets its queued replacement run without a cancelled outcome", async () => {
  const { store, runner, ticketId, workers } = fixture();
  runner.hold = true;
  await workers.dispatch(ticketId);
  const session = runner.sessions[0]!;
  assert.equal(workers.cancel(1), true);
  session.auto = true;
  workers.deliver(1, "replacement", "continue", () => {});
  await workers.drain();
  assert.deepEqual(session.prompts.slice(-1), ["continue"]);
  assert.equal(store.getAssignment(1).turnStartedAt, null);
  assert.equal(store.getAssignment(1).outcome, null);
  assert.equal(session.maxRunning, 1);
});

test("a reached ticket budget pauses after the current turn and asks the Worker to push WIP", async () => {
  const { store, runner, ticketId, workers } = fixture();
  store.setTicketBudget(ticketId, { timeMinutes: 480, idleMinutes: 30, turns: 1, tokens: 1_000_000, escalations: 0 });
  await workers.dispatch(ticketId);
  await workers.drain();
  assert.equal(store.getTicket(ticketId).state, "paused");
  assert.equal(store.getTicket(ticketId).pauseCause, "budget reached: turns");
  assert.match(runner.sessions[0]!.prompts[1]!, /Push your work in progress/);
  assert.equal(store.getAssignment(1).turns, 2);
});

test("the session starts on the configured harness", async () => {
  const claude = new FakeRunner();
  const codex = new FakeRunner();
  const { store, ticketId } = fixture();
  const workers = new Workers({ store, config: { ...config, harness: "claude", model: "claude-haiku-5-5" }, runners: { claude, codex }, addWorktree: async () => "b" });
  await workers.dispatch(ticketId);
  await workers.drain();
  assert.equal(claude.sessions.length, 1);
  assert.equal(codex.sessions.length, 0);
  assert.equal(store.getAssignment(1).harness, "claude");
});

test("a session that does not start ends the assignment with the reason and rethrows", async () => {
  const { store, runner, ticketId, workers } = fixture();
  runner.startFailure = new Error("no login");
  await assert.rejects(workers.dispatch(ticketId), /no login/);
  const a = store.getAssignment(1);
  assert.deepEqual([a.state, a.endReason, a.sessionId], ["ended", "no login", null]);
  assert.equal(store.abandonedAssignments().length, 1);
});

test("a worktree that cannot be made ends the assignment with the reason", async () => {
  const { store, ticketId, workers } = fixture({ addWorktree: async () => { throw new Error("branch exists"); } });
  await assert.rejects(workers.dispatch(ticketId), /branch exists/);
  assert.equal(store.getAssignment(1).endReason, "branch exists");
});

test("dispatch refuses an ended ticket without starting anything", async () => {
  const { store, runner, ticketId, workers } = fixture();
  store.endTicket(ticketId);
  await assert.rejects(workers.dispatch(ticketId), /takes no assignment/);
  assert.deepEqual(runner.sessions, []);
});

test("a turn that fails records a failed outcome; the next good turn clears it", async () => {
  const { store, runner, ticketId, workers } = fixture();
  runner.hold = false;
  await workers.dispatch(ticketId);
  await workers.drain();
  const session = () => runner.sessions.at(-1)!;
  session().failWith = new Error("boom");
  workers.deliver(1, "k1", "go", () => {});
  await workers.drain();
  assert.equal(store.getAssignment(1).outcome, "failed");
  assert.equal(store.getAssignment(1).turnStartedAt, null);
  session().failWith = undefined;
  workers.deliver(1, "k2", "again", () => {});
  await workers.drain();
  assert.equal(store.getAssignment(1).outcome, null);
  assert.equal(store.getAssignment(1).turns, 3);
});

test("a first turn that fails after the session started is a failed outcome, not an abandon", async () => {
  const { store, runner, ticketId, workers } = fixture();
  runner.failAfterId = new Error("crashed");
  await workers.dispatch(ticketId);
  await workers.drain();
  const a = store.getAssignment(1);
  assert.deepEqual([a.state, a.outcome, a.turnStartedAt], ["running", "failed", null]);
});

test("restart recovery resumes running sessions by id and sends the interrupted one a continue turn", async () => {
  const { store, runner, ticketId, workers, make } = fixture();
  runner.hold = true;
  await workers.dispatch(ticketId); // the first turn never finishes: ostromd "dies" here
  const second = store.createAssignment(store.getAssignment(1).ticketId);
  store.configureNativeAssignment(second, { harness: "codex", model: "m", worktree: "/w2", branch: "b2", machine: "h" });
  store.startNativeAssignment(second, "idle-session");
  const stuck = store.createAssignment(store.getAssignment(1).ticketId);
  store.configureNativeAssignment(stuck, { harness: "codex", model: "m", worktree: "/w3", branch: "b3", machine: "h" });

  const restarted = make();
  runner.hold = false;
  const pass = restarted.recover();
  assert.deepEqual(pass, { resumed: [1, second], interrupted: [1], abandoned: [stuck] });
  await restarted.drain();
  const resumed = runner.sessions.filter((s) => s.resumed);
  assert.deepEqual(resumed.map((s) => s.id), ["sess-1", "idle-session"]);
  assert.deepEqual(resumed[0]?.prompts, [INTERRUPTED_PROMPT]);
  assert.deepEqual(resumed[1]?.prompts, []);
  const a = store.getAssignment(1);
  assert.deepEqual([a.interruptions, a.turnStartedAt, a.state], [1, null, "running"]);
  assert.equal(store.getAssignment(second).interruptions, 0);
  assert.equal(store.getAssignment(stuck).state, "ended");
  assert.match(store.getAssignment(stuck).endReason!, /before the session started/);
});

test("a stop cuts off the running turn, starts no queued one, and leaves the turn for recovery", async () => {
  const { store, runner, ticketId, workers, make } = fixture();
  runner.hold = true;
  await workers.dispatch(ticketId);
  workers.deliver(1, "queued", "next", () => {});
  workers.stop();
  await workers.drain();
  assert.deepEqual(runner.sessions[0]!.prompts.length, 1, "the queued turn never started");
  const a = store.getAssignment(1);
  assert.deepEqual([a.state, a.outcome, a.lastError], ["running", null, null]);
  assert.notEqual(a.turnStartedAt, null, "the cut-off turn stays open");

  runner.hold = false;
  const restarted = make();
  assert.deepEqual(restarted.recover().interrupted, [1]);
  await restarted.drain();
  assert.deepEqual(runner.sessions.at(-1)!.prompts, [INTERRUPTED_PROMPT, "next"]);
  assert.equal(store.getAssignment(1).turnStartedAt, null);
});

test("queued turns survive closing and reopening the SQLite database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queued-turns-"));
  const path = join(dir, "store.sqlite");
  let store = Store.open(path);
  try {
    const source = store.ensureSource("github", REPO);
    const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: 7, url: `https://github.com/${REPO}/issues/7` });
    const triggerId = store.insertTrigger({ sourceId: source.id, threadId, sourceEventId: "accepted", kind: "issue_comment",
      actor: "alice", url: "https://example.test/comment", occurredAt: new Date() }).id;
    const ticketId = store.recordDecision({ threadId, triggerIds: [triggerId], verdict: "accept", reason: "work" }).ticketId!;
    const id = store.createAssignment(ticketId);
    store.configureNativeAssignment(id, { harness: "codex", model: "gpt-6-luna", worktree: "/wt", branch: "b", machine: "host" });
    store.startNativeAssignment(id, "durable-session");
    store.pauseTicket(ticketId);
    const runner = new FakeRunner();
    const workers = new Workers({ store, config, runners: { claude: runner, codex: runner } });
    workers.deliver(id, "disk-queue", "persisted prompt", () => {}, undefined, { reviewReply: { id: "review-disk", threadId } });
    await workers.drain();
    store.close();
    store = Store.open(path);
    store.resumeTicket(ticketId);
    const restarted = new Workers({ store, config, runners: { claude: runner, codex: runner } });
    restarted.recover();
    await restarted.drain();
    assert.deepEqual(runner.sessions[0]!.prompts, ["persisted prompt"]);
    assert.equal(store.hasReply("review-disk"), true);
    assert.equal(store.workerIdle(id), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("deferred turns retain their live start and completion callbacks", async () => {
  const { store, ticketId, workers } = fixture();
  await workers.dispatch(ticketId);
  await workers.drain();
  store.pauseTicket(ticketId);
  const effects: string[] = [];
  workers.deliver(1, "deferred", "do it", () => { effects.push("start"); }, () => { effects.push("complete"); });
  await workers.drain();
  assert.deepEqual(effects, []);
  assert.equal(store.queuedTurns(1).length, 1);
  store.resumeTicket(ticketId);
  assert.equal(workers.deliver(1, "deferred", "do it", () => { throw new Error("replaced callback"); }), false);
  await workers.drain();
  assert.deepEqual(effects, ["start", "complete"]);
  assert.deepEqual(store.queuedTurns(1), []);
});

test("restart retries persisted completion effects without rerunning the Worker", async () => {
  const { store, runner, ticketId, workers, make } = fixture();
  await workers.dispatch(ticketId);
  await workers.drain();
  const threadId = store.ticketContext(ticketId).thread.id;
  workers.deliver(1, "completion", "finish", () => {}, () => { throw new Error("outbox unavailable"); },
    { reviewReply: { id: "review-retry", threadId } });
  await workers.drain();
  assert.equal(store.queuedTurns(1)[0]!.state, "completed");
  assert.equal(store.getAssignment(1).turnStartedAt, null);
  const restarted = make();
  assert.deepEqual(restarted.recover().interrupted, []);
  await restarted.drain();
  assert.deepEqual(runner.sessions.at(-1)!.prompts, []);
  assert.equal(store.hasReply("review-retry"), true);
  assert.deepEqual(store.queuedTurns(1), []);
});

test("a merge reservation survives restart and prevents queued turns from starting", async () => {
  const { store, runner, ticketId, workers, make } = fixture();
  await workers.dispatch(ticketId);
  await workers.drain();
  assert.equal(store.reserveMerge(1), true);
  workers.deliver(1, "waiting", "later", () => {});
  await workers.drain();
  const restarted = make();
  restarted.recover();
  await restarted.drain();
  assert.equal(store.mergeReserved(1), true);
  assert.deepEqual(runner.sessions.at(-1)!.prompts, []);
  assert.equal(store.workerIdle(1), false);
  store.releaseMerge(1);
  restarted.schedule(1);
  await restarted.drain();
  assert.deepEqual(runner.sessions.at(-1)!.prompts, ["later"]);
});

test("an interrupted queued turn is replayed after recovery with its durable completion", async () => {
  const { store, runner, ticketId, workers, make } = fixture();
  await workers.dispatch(ticketId);
  await workers.drain();
  runner.sessions[0]!.auto = false;
  const threadId = store.ticketContext(ticketId).thread.id;
  workers.deliver(1, "review", "address review", () => {}, undefined, { reviewReply: { id: "review-durable", threadId } });
  await new Promise((resolve) => setImmediate(resolve));
  workers.stop();
  await workers.drain();
  const restarted = make();
  restarted.recover();
  await restarted.drain();
  assert.deepEqual(runner.sessions.at(-1)!.prompts, [INTERRUPTED_PROMPT, "address review"]);
  assert.equal(store.hasReply("review-durable"), true);
  assert.deepEqual(store.queuedTurns(1), []);
});

function rollout(model: string | null, thread = "sess-1") {
  const dir = mkdtempSync(join(tmpdir(), "workers-"));
  if (model !== null) {
    mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
    writeFileSync(
      join(dir, "2026", "11", "09", `rollout-2026-11-09T01-02-03-${thread}.jsonl`),
      JSON.stringify({ type: "turn_context", payload: { model } }) + "\n",
    );
  }
  return dir;
}

test("Codex: the recorded model matches, so the assignment carries on", async () => {
  const dir = rollout("gpt-6-luna");
  try {
    const { store, ticketId, workers } = fixture({ codexSessions: dir });
    await workers.dispatch(ticketId);
    await workers.drain();
    assert.equal(store.getAssignment(1).state, "running");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("Codex: a different model or an unreadable record ends the assignment with a recorded reason", async () => {
  for (const [model, reason] of [["gpt-6-sol", /model mismatch: asked for gpt-6-luna, ran gpt-6-sol/], [null, /model unverified: no rollout record/]] as const) {
    const dir = rollout(model);
    try {
      const { store, ticketId, workers } = fixture({ codexSessions: dir });
      await workers.dispatch(ticketId);
      await workers.drain();
      const a = store.getAssignment(1);
      assert.equal(a.state, "ended");
      assert.match(a.endReason!, reason);
      assert.equal(store.abandonedAssignments().length, 1, "the Router owes a reply");
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test("Claude turns are not checked against a rollout", async () => {
  const { store, ticketId, workers } = fixture({ codexSessions: "/does/not/exist" }, "claude");
  await workers.dispatch(ticketId);
  await workers.drain();
  assert.equal(store.getAssignment(1).state, "running");
});
