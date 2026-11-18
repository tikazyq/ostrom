// Derives the current quiet status card from durable ticket and assignment state. Worker plans are
// not yet persisted by the native runners, so their latest todo is deliberately omitted for now.

import { assessBudget } from "../worker/budget.ts";
import type { Store } from "../store/store.ts";
import { renderStatusCard, type StatusCardState } from "./status-card.ts";

export function queueStatusCard(store: Store, ticketId: number, now = new Date(), idleMs = 0): void {
  const context = store.ticketContext(ticketId);
  const ticket = context.ticket;
  const assignment = store.latestAssignment(ticketId);
  if (assignment === null || assignment.harness === null || assignment.model === null) return;
  const stall = store.openStall(assignment.id);
  const state: StatusCardState =
    ticket.state === "ended" ? (assignment.endReason === null ? "done" : "stopped") :
      ticket.state === "paused" ? "paused" :
        stall?.blockedAt ? "stuck" : stall !== null ? "recovering" : "working";
  const lastActivityAt = new Date(assignment.lastTurnAt ?? assignment.outcomeAt ?? assignment.startedAt ?? assignment.createdAt);
  store.enqueueStatusCard(
    context.thread.id,
    renderStatusCard({
      state,
      ...(ticket.state === "paused" && ticket.budgetPause !== null ? { budgetPause: ticket.budgetPause } : {}),
      ...(ticket.state === "open" ? { budgetWarning: assessBudget(ticket.budget, store.budgetUsage(ticketId, idleMs)).warning } : {}),
      ...(assignment.endReason === "issue closed" ? { stoppedReason: "issue closed" as const } : {}),
      harness: assignment.harness,
      model: assignment.model,
      lastActivityAt,
      now,
      markerId: `card-thread-${context.thread.id}`,
    }),
  );
}
