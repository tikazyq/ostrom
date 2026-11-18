import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { FakeGitHub } from "../github/fake-github.ts";
import { sendDueReplies } from "../github/outbox.ts";
import { loadBudgetDefaults, loadConfig } from "../ostromd/config.ts";
import { routeCandidates } from "../router/router.ts";
import { Store } from "../store/store.ts";
import { FakeRunner } from "../worker/fake-runner.ts";
import { routeFollowUps } from "../worker/follow-up.ts";
import { Workers } from "../worker/workers.ts";
import { seedScriptedStall } from "./scripted-stall.ts";
import { advanceStuckLadder, parseStuckReply, renderStuckReply } from "./stuck.ts";
import { watchdog } from "./watchdog.ts";

test("stuck reply snapshot", () => {
  assert.equal(
    renderStuckReply({
      tryingTo: "update the parser", blockedBy: "the expected format is unclear", tried: "read the fixtures",
      choices: "1. use format A\n2. use format B", workSoFar: "The branch has the parser change.",
    }),
    [
      "**I'm stuck on this and need a decision.**",
      "**Trying to:** update the parser",
      "**Blocked by:** the expected format is unclear",
      "**Tried:** read the fixtures",
      "**I need you to choose:** 1. use format A\n2. use format B",
      "**Work so far:** The branch has the parser change. Reply with a number, or anything else to redirect.",
    ].join("\n"),
  );
});

test("malformed Worker reply gets a complete, honest fallback", () => {
  assert.deepEqual(parseStuckReply('{"tryingTo":"only one field"}', "budget reached: tokens"), {
    tryingTo: "complete the requested work", blockedBy: "budget reached: tokens",
    tried: "two automatic recovery attempts on the same Worker session",
    choices: "1. provide the missing decision\n2. stop this ticket",
    workSoFar: "The Worker was asked to push its work in progress before this message.",
  });
});

test("a daemon-dispatched stall is interrupted twice, then posts one public reply", async () => {
  let now = new Date();
  const clock = () => now;
  const store = Store.open(":memory:", { now: clock });
  try {
    const github = new FakeGitHub(clock);
    github.issue(7);
    const env = { OSTROM_REPO: github.repo, OSTROM_ALLOWLIST: "alice", OSTROM_DB: ":memory:" };
    const ticketId = seedScriptedStall(store, loadConfig(env), 7, loadBudgetDefaults(env));
    assert.equal(store.latestAssignment(ticketId), null);
    const runner = new FakeRunner();
    runner.hold = true;
    const runners = { claude: runner, codex: runner };
    const workers = new Workers({
      store, runners, addWorktree: async () => "ostrom/ticket-1-1",
      config: { repo: "/repo", base: "main", worktrees: "/wt", harness: "codex", model: "gpt-6-luna", machine: "host" },
    });
    const dispatch = await routeCandidates({
      store, workers, runners, gh: github.gh, repo: github.repo,
      router: { harness: "codex", model: "gpt-6-luna" },
    });
    assert.deepEqual(dispatch.failed, []);
    assert.equal(dispatch.dispatched.length, 1);
    const { assignmentId, branch, sessionId } = dispatch.dispatched[0]!;
    const session = runner.sessions[0]!;
    assert.equal(session.id, sessionId);
    assert.match(session.prompts[0]!, /sleep 3600/);

    const check = () => watchdog({
      store, now: clock, idleMinutes: 2,
      semon: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({
        idle_minutes: 2, stalls: [{ id: sessionId, branch, stall_reason: "no-output", open_question: null }],
      }) }),
    });
    const ageTurn = () => { now = new Date(now.getTime() + 2 * 60_000); };
    for (const attempt of [1, 2]) {
      ageTurn();
      const [stalled] = (await check()).checked;
      assert.equal(stalled?.newEpisode, true);
      assert.deepEqual(await advanceStuckLadder(store, workers), { recovered: [stalled!.stallId], published: [] });
      await setImmediate();
      assert.equal(session.aborted, attempt);
      assert.equal(session.running, 1, "the recovery turn is now hanging on the same session");
      assert.equal(store.getAssignment(assignmentId).outcome, null);
      // A fresh turn is too young for Semon's signal. The episode clears, but its attempt counts.
      assert.equal((await check()).checked[0]!.clearedStallId, stalled!.stallId);
      assert.equal(store.getAssignment(assignmentId).recoveryAttempts, attempt);
    }

    ageTurn();
    const [stalled] = (await check()).checked;
    assert.equal(stalled?.newEpisode, true);
    session.auto = true;
    session.reply = () => JSON.stringify({
      tryingTo: "exercise the watchdog", blockedBy: "the scripted sleep",
      tried: "two recovery turns", choices: "1. resume\n2. stop", workSoFar: "No changes were made.",
    });
    const ladder = await advanceStuckLadder(store, workers);
    assert.deepEqual(ladder, { recovered: [], published: [stalled!.stallId] });
    assert.equal(session.aborted, 3);
    await workers.drain();
    assert.equal(session.maxRunning, 1);
    assert.equal(runner.sessions.length, 1);
    assert.match(session.prompts[1]!, /detected that this ticket is stuck/);
    assert.match(session.prompts[2]!, /still sees this ticket as stuck/);
    assert.match(session.prompts[3]!, /public|GitHub stuck reply/);
    assert.equal(store.getTicket(ticketId).state, "paused");
    assert.deepEqual(await advanceStuckLadder(store, workers), { recovered: [], published: [] });
    const sent = await sendDueReplies({ store, gh: github.gh, repo: github.repo, now: clock });
    assert.deepEqual(sent.failed, []);
    assert.ok(sent.sent.includes(`stuck-${stalled!.stallId}`));
    const replies = github.commentsOn(7).filter((item) => String(item["body"]).includes("need a decision"));
    assert.equal(replies.length, 1);
    assert.match(String(replies[0]!["body"]), /Blocked by:\*\* the scripted sleep/);

    const thread = store.ticketContext(ticketId).thread;
    store.insertTrigger({
      sourceId: thread.sourceId, threadId: thread.id, sourceEventId: "human-reply", kind: "issue_comment",
      actor: "alice", body: "1", url: `${thread.url}#issuecomment-42`, occurredAt: now,
    });
    const followUps = routeFollowUps(store, workers);
    assert.deepEqual(followUps.failed, []);
    assert.equal(followUps.queued.length, 1);
    await workers.drain();
    assert.equal(store.getTicket(ticketId).state, "open");
    assert.equal(store.getAssignment(assignmentId).recoveryAttempts, 0);
  } finally {
    store.close();
  }
});
