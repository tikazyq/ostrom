import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store, type OperatorIntake, type OperatorTicket, type OperatorTicketDetail } from "../store/store.ts";
import { defaultSocketPath, localApi, type OperatorDaemonStatus } from "./server.ts";

function get(socketPath: string, path: string): Promise<{ status: number; body: unknown }> {
  return call(socketPath, "GET", path);
}

function call(socketPath: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const options = encoded === undefined ? { socketPath, path, method } : {
      socketPath, path, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) },
    };
    const client = request(options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    client.once("error", reject);
    client.end(encoded);
  });
}

function fixture(path: string): number {
  const store = Store.open(path);
  try {
    const source = store.ensureSource("github", "onsager-ai/ostrom");
    const thread = store.ensureThread({ sourceId: source.id, kind: "issue", number: 7, url: "https://example.test/issues/7" });
    const trigger = store.insertTrigger({
      sourceId: source.id, sourceEventId: "event-7", threadId: thread, kind: "issue_comment", actor: "alice",
      url: "https://example.test/issues/7#comment", occurredAt: new Date(), body: "please fix it",
    }).id;
    const ticket = store.recordDecision({ threadId: thread, triggerIds: [trigger], verdict: "accept", reason: "requested fix" }).ticketId!;
    store.setTicketBudget(ticket, { timeMinutes: 480, idleMinutes: 30, turns: 80, tokens: 20, escalations: 0 });
    const failed = store.createAssignment(ticket);
    store.abandonAssignment(failed, "worktree creation failed");
    const assignment = store.createAssignment(ticket);
    const pr = store.ensureThread({ sourceId: source.id, kind: "pull_request", number: 8, url: "https://example.test/pull/8" });
    store.subscribe(ticket, pr);
    store.upsertMergeCandidate({
      assignmentId: assignment, repository: source.name, prNumber: 8, headSha: "head", baseSha: "base",
      policy: "approvals", activityFingerprint: null, activityAt: null, readyReplyId: null, readySentAt: null,
      quietDeadline: new Date("2026-11-09T12:00:00Z"), blockingReason: "policy approvals are not satisfied",
    });
    store.configureNativeAssignment(assignment, { harness: "codex", model: "gpt-6-luna", worktree: "/work/ticket-1", branch: "ostrom/ticket-1-1", machine: "host" });
    store.startNativeAssignment(assignment, "sess-1");
    store.beginTurn(assignment);
    store.endTurn(assignment, { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4 });
    store.enqueueReply({ id: "reply-1", threadId: thread, body: "Taking this." });
    return ticket;
  } finally {
    store.close();
  }
}

test("the local API serves status, tickets and a ticket over a 0600 Unix socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-api-"));
  const database = join(directory, "ostrom.sqlite");
  const socketPath = join(directory, "run", "ostromd.sock");
  const ticketId = fixture(database);
  const store = Store.open(database);
  const api = localApi(store, {
    socketPath,
    temperature: async () => 42,
    control: {
      pause: async (id) => { store.pauseTicket(id); },
      resume: async (id) => { store.resumeTicket(id); }, stop: async () => {},
      extend: async (id, increases) => { store.extendTicketBudget(id, increases); }, preview: async () => "",
    },
  });
  try {
    await api.start();
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);

    const status = await get(socketPath, "/v1/status");
    assert.equal(status.status, 200);
    const statusBody = status.body as OperatorDaemonStatus;
    assert.deepEqual(statusBody.machine, { slots: { total: availableParallelism(), used: 1, label: "CPU parallelism" }, temperature: 42 });
    assert.equal(statusBody.tickIntervalSeconds, null);
    assert.deepEqual(statusBody.watchdog, { lastAttemptAt: null, ok: null, lastSuccessAt: null, error: null });
    assert.deepEqual(statusBody.tickets, { open: 1, paused: 0, ended: 0 });
    assert.deepEqual(statusBody.runningWorkers.map((worker) => ({
      sessionId: worker.sessionId, turns: worker.turns, inputTokens: worker.inputTokens, outputTokens: worker.outputTokens,
    })), [{ sessionId: "sess-1", turns: 1, inputTokens: 12, outputTokens: 4 }]);
    assert.deepEqual(statusBody.stuckTickets, []);
    assert.equal(statusBody.tokensToday, 16);

    const tickets = await get(socketPath, "/v1/tickets");
    assert.equal(tickets.status, 200);
    const list = tickets.body as OperatorTicket[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, ticketId);
    assert.equal(list[0]!.assignment?.sessionId, "sess-1");

    const detail = await get(socketPath, `/v1/tickets/${ticketId}`);
    assert.equal(detail.status, 200);
    const shown = detail.body as OperatorTicketDetail;
    for (const ticket of [list[0]!, shown]) {
      assert.deepEqual(ticket.prUrls, ["https://example.test/pull/8"]);
      assert.deepEqual(ticket.mergeCandidate, {
        prNumber: 8, policy: "approvals", blockingReason: "policy approvals are not satisfied",
        quietDeadline: "2026-11-09T12:00:00.000Z",
      });
      assert.equal(ticket.latestFailure?.reason, "worktree creation failed");
      assert.deepEqual(ticket.failures, [ticket.latestFailure]);
      assert.equal(ticket.budgetUsage.tokens, 16);
      assert.equal(ticket.budgetUsage.idle, 0);
      assert.equal(ticket.budget.cachedInputTokens, 3);
      assert.equal(ticket.budgetWarning, "tokens");
    }
    assert.equal(shown.context.reason, "requested fix");
    assert.equal(shown.triggers[0]!.body, "please fix it");
    assert.equal(shown.outbox[0]!.id, "reply-1");

    const paused = await call(socketPath, "POST", `/v1/tickets/${ticketId}/pause`);
    assert.equal(paused.status, 200);
    assert.equal((paused.body as { state: string }).state, "paused");
    const resumed = await call(socketPath, "POST", `/v1/tickets/${ticketId}/resume`);
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body as { state: string }).state, "open");
    const extended = await call(socketPath, "POST", `/v1/tickets/${ticketId}/extend`, { turns: 2 });
    assert.equal(extended.status, 200);
    assert.equal(((extended.body as { budget: { turnLimit: number } }).budget).turnLimit, 82);
  } finally {
    await api.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("intake returns the newest observations first with a default and explicit limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-intake-"));
  const socketPath = join(directory, "ostromd.sock");
  let now = Date.parse("2026-11-09T12:00:00Z");
  const store = Store.open(":memory:", { now: () => new Date(now++) });
  const api = localApi(store, {
    socketPath,
    control: { pause: async () => {}, resume: async () => {}, stop: async () => {}, extend: async () => {}, preview: async () => "" },
  });
  try {
    const source = store.ensureSource("github", "example/repo");
    const issueUrl = "https://example.test/issues";
    for (let i = 1; i <= 49; i++) {
      store.recordIntakeExclusion({ sourceId: source.id, sourceEventId: `I_${i}:opened`, url: `${issueUrl}/${i}`, reason: "missing_mention" });
    }
    const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: 50, url: `${issueUrl}/50` });
    const insert = (id: number) => store.insertTrigger({
      sourceId: source.id, sourceEventId: `IC_${id}`, threadId, kind: "issue_comment", actor: "alice",
      url: `${issueUrl}/50#comment-${id}`, occurredAt: new Date(now), body: "Router input",
    }).id;
    const ignored = insert(1);
    insert(2);
    store.recordDecision({ threadId, triggerIds: [ignored], verdict: "ignore", reason: "out of scope" });
    await api.start();

    const result = await get(socketPath, "/v1/intake");
    assert.equal(result.status, 200);
    const rows = result.body as OperatorIntake[];
    assert.equal(rows.length, 50);
    assert.deepEqual(rows.slice(0, 3).map(({ url, disposition, reason }) => [url, disposition, reason]), [
      [`${issueUrl}/50#comment-2`, "awaiting_decision", null],
      [`${issueUrl}/50#comment-1`, "ignore", "out of scope"],
      [`${issueUrl}/49`, "excluded", "missing_mention"],
    ]);
    assert.equal(rows.at(-1)!.url, `${issueUrl}/2`);
    assert.equal(rows[0]!.observedAt > rows[1]!.observedAt, true);
    assert.deepEqual(await get(socketPath, "/v1/intake?limit=2"), { status: 200, body: rows.slice(0, 2) });
    assert.equal((await get(socketPath, "/v1/intake?limit=-1")).status, 400);
    assert.equal((await call(socketPath, "POST", "/v1/intake")).status, 404);
  } finally {
    await api.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("socket path uses XDG runtime and otherwise local state", () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/ostrom/ostromd.sock");
  assert.equal(defaultSocketPath({ HOME: "/home/alice" }), "/home/alice/.local/state/ostrom/ostromd.sock");
});
