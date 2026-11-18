import assert from "node:assert/strict";
import { test } from "node:test";

import { budgetReached, budgetUsage, budgetWarning, DEFAULT_BUDGET, loadBudgetDefaults } from "./budgets.ts";
import { Store, type TicketBudget } from "../store/store.ts";

const OPENED = "2026-11-09T12:00:00.000Z";
const NOW = new Date("2026-11-09T12:48:00.000Z");

function budget(overrides: Partial<TicketBudget> = {}): TicketBudget {
  return {
    ticketId: 1, openedAt: OPENED, timeMinutes: 60, idleMinutes: 30, turnLimit: 10,
    tokenLimit: 100, escalationLimit: 0, escalations: 0, turns: 8,
    inputTokens: 40, cachedInputTokens: 30, outputTokens: 10,
    turnStartedAt: "2026-11-09T12:18:00.000Z", ...overrides,
  };
}

test("budget accounting excludes cached input from token limits but keeps it in stored usage", () => {
  assert.equal(budgetUsage(budget(), "tokens", NOW), 50);
  assert.equal(budgetWarning(budget(), NOW), "time");
  assert.equal(budgetReached(budget(), NOW), "idle");
  assert.equal(budgetReached(budget({ idleMinutes: 60, escalationLimit: 1, escalations: 1 }), NOW), "escalations");
  assert.equal(budgetWarning(budget({ timeMinutes: 120, idleMinutes: 60 }), NOW), "turns");
});

test("idle time counts only while a turn runs, from that turn's start", () => {
  assert.equal(budgetUsage(budget(), "idle", NOW), 30);
  assert.equal(budgetUsage(budget({ turnStartedAt: null }), "idle", NOW), 0, "a Worker waiting for review is not idle");
  assert.equal(budgetReached(budget({ turnStartedAt: null, timeMinutes: 120, turnLimit: 20 }), NOW), null);
});

test("extensions require every limit to clear and preserve operator pauses and wall-clock accounting", () => {
  let now = new Date(OPENED);
  const store = Store.open(":memory:", { now: () => now });
  try {
    const source = store.ensureSource("github", "o/r");
    const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: 1, url: "https://github.com/o/r/issues/1" });
    const trigger = store.insertTrigger({ sourceId: source.id, sourceEventId: "start", threadId, kind: "issue_comment", actor: "alice", url: "https://github.com/o/r/issues/1#start", occurredAt: now }).id;
    const ticket = store.recordDecision({ threadId, triggerIds: [trigger], verdict: "accept", reason: "work" }, { ...DEFAULT_BUDGET, timeMinutes: 60 }).ticketId!;
    const assignment = store.createAssignment(ticket);
    store.configureNativeAssignment(assignment, { harness: "codex", model: "m", worktree: "/wt", branch: "b", machine: "h" });
    store.startNativeAssignment(assignment, "s");
    store.beginTurn(assignment);
    store.endTurn(assignment, { inputTokens: 1_000_100, cachedInputTokens: 0, outputTokens: 0 });
    now = new Date("2026-11-09T14:00:00.000Z");
    store.pauseTicketForBudget(ticket, "time");
    store.extendTicketBudget(ticket, { tokens: 100 });
    assert.equal(store.getTicket(ticket).state, "paused", "wrong budget");
    store.extendTicketBudget(ticket, { timeMinutes: 30 });
    assert.equal(store.getTicket(ticket).state, "paused", "insufficient extension");
    store.extendTicketBudget(ticket, { timeMinutes: 30 });
    assert.equal(store.getTicket(ticket).state, "paused", "equality still reaches the limit");
    store.extendTicketBudget(ticket, { timeMinutes: 1 });
    assert.equal(store.getTicket(ticket).state, "paused", "another exhausted limit blocks reopening");
    store.extendTicketBudget(ticket, { tokens: 1 });
    assert.equal(store.getTicket(ticket).state, "open");
    assert.equal(store.getTicket(ticket).pauseCause, null);
    assert.equal(budgetUsage(store.ticketBudget(ticket), "time", now), 120);
    store.pauseTicket(ticket, "paused by the operator");
    store.extendTicketBudget(ticket, { timeMinutes: 60 });
    assert.equal(store.getTicket(ticket).state, "paused");
    assert.equal(store.getTicket(ticket).pauseCause, "paused by the operator");
  } finally {
    store.close();
  }
});

test("budget defaults are documented constants and env values are validated", () => {
  assert.deepEqual(loadBudgetDefaults({}), DEFAULT_BUDGET);
  assert.deepEqual(loadBudgetDefaults({ OSTROM_BUDGET_TIME_MIN: "12", OSTROM_BUDGET_ESCALATIONS: "2" }), {
    ...DEFAULT_BUDGET, timeMinutes: 12, escalations: 2,
  });
  assert.throws(() => loadBudgetDefaults({ OSTROM_BUDGET_TOKENS: "0" }), /OSTROM_BUDGET_TOKENS/);
  assert.throws(() => loadBudgetDefaults({ OSTROM_BUDGET_ESCALATIONS: "-1" }), /OSTROM_BUDGET_ESCALATIONS/);
});
