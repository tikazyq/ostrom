import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../store/store.ts";
import { DEFAULT_LIMITS, MINUTE_MS } from "../worker/budget.ts";
import { main } from "./main.ts";

test("extend persists additive limits and requests resume on the retained session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ostrom-extend-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ostrom.sqlite");
  const store = Store.open(path);
  const source = store.ensureSource("github", "o/r");
  const issue = store.ensureThread({ sourceId: source.id, kind: "issue", number: 1, url: "https://github.com/o/r/issues/1" });
  const trigger = store.insertTrigger({ sourceId: source.id, threadId: issue, sourceEventId: "event", kind: "issue_comment",
    actor: "someone", url: "https://github.com/o/r/issues/1#issuecomment-1", occurredAt: new Date() }).id;
  const ticket = store.recordDecision({ threadId: issue, triggerIds: [trigger], verdict: "accept", reason: "fix it" }).ticketId!;
  const assignment = store.createAssignment(ticket);
  store.configureNativeAssignment(assignment, { harness: "claude", model: "m", branch: "b", worktree: "/w", machine: "host" });
  store.startNativeAssignment(assignment, "session-1");
  assert.deepEqual(store.getTicket(ticket).budget, DEFAULT_LIMITS);
  store.beginTurn(assignment);
  store.endTurn(assignment, { inputTokens: DEFAULT_LIMITS.tokens, cachedInputTokens: 1, outputTokens: 0 });
  assert.equal(store.beginBudgetPause(assignment, "tokens"), true);
  store.endTurn(assignment, null);
  store.close();

  const out: string[] = [];
  const err: string[] = [];
  const invoke = (...args: string[]) => main(["extend", String(ticket), ...args], { OSTROM_DB: path }, {
    stdout: (text) => out.push(text), stderr: (text) => err.push(text),
  });
  assert.equal(await invoke(), 2);
  assert.equal(await invoke("--turns", "0"), 2);
  assert.equal(await invoke("--turns", "2", "--turns", "3"), 2);
  assert.equal(await invoke("--time", "1h"), 2);
  assert.equal(await invoke("--time", "5", "--tokens", "1"), 1);
  assert.match(err.at(-1)!, /needs more budget/);
  assert.equal(await invoke("--time", "5", "--turns", "3", "--tokens", "100"), 0);
  assert.match(out.at(-1)!, /Worker will resume/);

  const reopened = Store.open(path);
  t.after(() => reopened.close());
  assert.equal(reopened.getTicket(ticket).state, "open");
  assert.equal(reopened.getTicket(ticket).budgetResume, true);
  assert.deepEqual(reopened.getTicket(ticket).budget, {
    ...DEFAULT_LIMITS, wallMs: DEFAULT_LIMITS.wallMs + 5 * MINUTE_MS, turns: DEFAULT_LIMITS.turns + 3, tokens: DEFAULT_LIMITS.tokens + 100,
  });
  assert.equal(reopened.latestAssignment(ticket)?.sessionId, "session-1");
  assert.equal(reopened.budgetUsage(ticket).tokens, DEFAULT_LIMITS.tokens + 1);
});
