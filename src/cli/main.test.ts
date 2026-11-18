import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../store/store.ts";
import { main } from "./main.ts";

function ticket(path: string): number {
  const store = Store.open(path);
  try {
    const source = store.ensureSource("github", "onsager-ai/ostrom");
    const thread = store.ensureThread({ sourceId: source.id, kind: "issue", number: 1, url: "https://example.test/1" });
    const trigger = store.insertTrigger({
      sourceId: source.id, sourceEventId: "event-1", threadId: thread, kind: "issue_comment", actor: "alice",
      url: "https://example.test/1#comment", occurredAt: new Date(),
    }).id;
    const id = store.recordDecision({ threadId: thread, triggerIds: [trigger], verdict: "accept", reason: "work" }).ticketId!;
    const assignment = store.createAssignment(id);
    store.configureNativeAssignment(assignment, { harness: "claude", model: "haiku", worktree: "/w", branch: "b", machine: "h" });
    const turn = store.startWorkerTurn(assignment, "dispatch", "low");
    store.finishWorkerTurn(turn.id, { observedModel: "gateway-haiku", observedEffort: null, status: "completed", freshTokens: 12, result: null });
    return id;
  } finally {
    store.close();
  }
}

test("read-only CLI falls back to the store and shows turn records", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-"));
  const path = join(directory, "ostrom.db");
  try {
    const id = ticket(path);
    assert.equal(await main(["tickets", "--json"], { OSTROM_DB: path, HOME: directory }), 0);
    const writes = context.mock.method(process.stdout, "write", (_chunk: string | Uint8Array) => true);
    const env = { OSTROM_DB: path, HOME: directory };
    assert.equal(await main(["show", String(id), "--json"], env), 0);
    const json = JSON.parse(String(writes.mock.calls.at(-1)?.arguments[0]));
    assert.equal(json.turns[0].observedModel, "gateway-haiku");
    writes.mock.resetCalls();
    assert.equal(await main(["show", String(id)], env), 0);
    const text = writes.mock.calls.map(({ arguments: args }) => args[0]).join("");
    assert.match(text, /turn 1  assignment 1  dispatch  completed/);
    assert.match(text, /requested haiku \/ low  observed gateway-haiku \/ unknown/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mutating CLI commands require a running daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-"));
  const path = join(directory, "ostrom.db");
  try {
    const id = ticket(path);
    assert.equal(await main(["extend", String(id), "--time", "60"], { OSTROM_DB: path, HOME: directory }), 1);
    const unchanged = Store.open(path);
    try {
      assert.equal(unchanged.ticketBudget(id).timeMinutes, 480);
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
