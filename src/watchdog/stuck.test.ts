import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeGitHub } from "../github/fake-github.ts";
import { sendDueReplies } from "../github/outbox.ts";
import { Store } from "../store/store.ts";
import { FakeRunner } from "../worker/fake-runner.ts";
import { routeFollowUps } from "../worker/follow-up.ts";
import { Workers } from "../worker/workers.ts";
import { seedScriptedStall, STALL_BRIEF } from "./scripted-stall.ts";
import { advanceStuckLadder, parseStuckReply, renderStuckReply } from "./stuck.ts";

test("daemon-dispatched stall reaches one public reply across separate Semon episodes", async () => {
  const store = Store.open(":memory:");
  try {
    const github = new FakeGitHub(() => new Date());
    github.issue(7);
    const ticketId = seedScriptedStall(store, github.repo, "alice", 7);
    assert.equal(store.latestAssignment(ticketId), null, "the script leaves dispatch to ostromd");
    assert.equal(store.ticketContext(ticketId).reason, STALL_BRIEF);
    const runner = new FakeRunner();
    runner.hold = true;
    const workers = new Workers({
      store,
      config: { repo: "/repo", base: "main", worktrees: "/wt", harness: "codex", model: "gpt-6-luna", machine: "host" },
      runners: { codex: runner, claude: runner },
      addWorktree: async () => "ostrom/ticket-1-1",
    });
    const { assignmentId } = await workers.dispatch(ticketId);
    const session = runner.sessions[0]!;
    assert.match(session.prompts[0]!, /sleep 3600/);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const stall = store.recordStall({ assignmentId, semonReason: "no-output", detail: null });
      const pass = await advanceStuckLadder(store, workers);
      assert.deepEqual(pass.recovered, [stall.id]);
      // Let the cancellation finish and the queued recovery enter the fake runner.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(session.prompts.length, attempt + 1);
      assert.equal(store.getAssignment(assignmentId).outcome, null);
      assert.equal(store.getAssignment(assignmentId).recoveryAttempts, attempt);
      store.clearStall(assignmentId);
    }
    const publicStall = store.recordStall({ assignmentId, semonReason: "no-output", detail: null });
    session.auto = true;
    session.reply = () => JSON.stringify({
      tryingTo: "exercise the watchdog", blockedBy: "scripted sleep", tried: "two recoveries",
      choices: "1. stop\n2. continue", workSoFar: "No edits were made.",
    });
    assert.deepEqual((await advanceStuckLadder(store, workers)).published, [publicStall.id]);
    await workers.drain();
    await advanceStuckLadder(store, workers);
    await workers.drain();
    assert.equal(session.prompts.length, 4);
    assert.equal(session.maxRunning, 1);
    assert.equal(store.getTicket(ticketId).state, "paused");
    assert.equal(store.dueReplies().filter((reply) => reply.id === `stuck-${publicStall.id}`).length, 1);
    assert.deepEqual((await sendDueReplies({ store, gh: github.gh, repo: github.repo })).failed, []);
    assert.equal(github.issueComments.filter((comment) => String(comment["body"]).includes("**I'm stuck")).length, 1);

    const context = store.ticketContext(ticketId);
    store.insertTrigger({
      sourceId: context.source.id, sourceEventId: "human-reply", threadId: context.thread.id,
      kind: "issue_comment", actor: "alice", url: `${context.thread.url}#issuecomment-2`, occurredAt: new Date(),
    });
    routeFollowUps(store, workers);
    await workers.drain();
    assert.equal(store.getAssignment(assignmentId).recoveryAttempts, 0);
    assert.equal(store.getTicket(ticketId).state, "open");
    assert.notEqual(store.getStall(publicStall.id).clearedByHumanAt, null);
  } finally {
    store.close();
  }
});

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
