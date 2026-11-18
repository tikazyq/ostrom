import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../store/store.ts";
import { defaultSocketPath, localApi, type ApiStatus } from "./server.ts";
import type { OperatorTicket } from "../store/store.ts";

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
    const assignment = store.createAssignment(ticket);
    store.configureNativeAssignment(assignment, { harness: "codex", model: "gpt-6-luna", worktree: "/work/ticket-1", branch: "ostrom/ticket-1-1", machine: "host" });
    store.startNativeAssignment(assignment, "sess-1");
    store.beginTurn(assignment);
    store.endTurn(assignment, { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4 });
    store.recordTurnError(assignment, "resume failed");
    store.clearTurnError(assignment);
    const pr = store.ensureThread({ sourceId: source.id, kind: "pull_request", number: 8, url: "https://example.test/pull/8" });
    store.subscribe(ticket, pr);
    store.upsertMergeCandidate({ assignmentId: assignment, repository: source.name, prNumber: 8,
      headSha: "head", baseSha: "base", policy: "unattended", activityFingerprint: null, activityAt: null,
      readyReplyId: null, readySentAt: null, quietDeadline: null, blockingReason: "quiet period has not elapsed" });
    store.recordIntakeReceipt({ sourceId: source.id, sourceEventId: "excluded", url: "https://example.test/issues/9", reason: "missing_mention" });
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
    tickIntervalSeconds: 15,
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
    const statusBody = status.body as {
      tickets: { open: number; paused: number; ended: number };
      runningWorkers: { sessionId: string; inputTokens: number; outputTokens: number; turns: number }[];
      stuckTickets: unknown[];
      tokensToday: number;
    };
    assert.deepEqual(statusBody.tickets, { open: 1, paused: 0, ended: 0 });
    assert.deepEqual(statusBody.runningWorkers.map((worker) => ({
      sessionId: worker.sessionId, turns: worker.turns, inputTokens: worker.inputTokens, outputTokens: worker.outputTokens,
    })), [{ sessionId: "sess-1", turns: 1, inputTokens: 12, outputTokens: 4 }]);
    assert.deepEqual(statusBody.stuckTickets, []);
    assert.equal(statusBody.tokensToday, 16);
    const health = status.body as ApiStatus;
    assert.deepEqual(health.watchdog, { lastAttemptAt: null, status: "unknown", lastSuccessAt: null, error: null });
    assert.equal(health.tickIntervalSeconds, 15);
    assert.equal(health.machine.slots.label, "CPU parallelism");
    const intake = await get(socketPath, "/v1/intake?limit=1");
    assert.equal(intake.status, 200);
    assert.equal((intake.body as unknown[]).length, 1);
    assert.equal(((await get(socketPath, "/v1/intake")).body as unknown[]).length, 2);
    for (const limit of ["0", "-1", "1.5", "foo", "9007199254740992"]) {
      assert.equal((await get(socketPath, `/v1/intake?limit=${limit}`)).status, 400);
    }

    const tickets = await get(socketPath, "/v1/tickets");
    assert.equal(tickets.status, 200);
    const list = tickets.body as { id: number; assignment: { sessionId: string } }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, ticketId);
    assert.equal(list[0]!.assignment.sessionId, "sess-1");
    const projected = (tickets.body as OperatorTicket[])[0]!;
    assert.deepEqual(projected.prUrls, ["https://example.test/pull/8"]);
    assert.equal(projected.mergeCandidate!.blockingReason, "quiet period has not elapsed");
    assert.equal(projected.latestFailure!.error, "resume failed");
    assert.equal(projected.failures.length, 1);
    assert.equal(projected.budgetUsage.tokens, 16);
    assert.equal(projected.budgetWarning, null);

    const detail = await get(socketPath, `/v1/tickets/${ticketId}`);
    assert.equal(detail.status, 200);
    const shown = detail.body as { context: { reason: string }; triggers: { body: string }[]; outbox: { id: string }[] };
    assert.equal(shown.context.reason, "requested fix");
    assert.equal(shown.triggers[0]!.body, "please fix it");
    assert.equal(shown.outbox[0]!.id, "reply-1");
    assert.deepEqual((detail.body as OperatorTicket).failures, projected.failures);
    assert.deepEqual((detail.body as OperatorTicket).mergeCandidate, projected.mergeCandidate);

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

test("socket path uses XDG runtime and otherwise local state", () => {
  assert.equal(defaultSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000/ostrom/ostromd.sock");
  assert.equal(defaultSocketPath({ HOME: "/home/alice" }), "/home/alice/.local/state/ostrom/ostromd.sock");
});
