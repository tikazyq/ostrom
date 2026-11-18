// The one quiet, editable status comment per thread. GitHub does not notify people about edits,
// so this carries routine progress while normal outbox comments remain for moments needing action.

import { BUDGET_LABEL, type BudgetMetric } from "../worker/budget.ts";
import { controlsLine } from "../commands/table.ts";
import { replyMarker } from "./marker.ts";

export type StatusCardState = "working" | "paused" | "recovering" | "stuck" | "done" | "stopped";

export interface StatusCard {
  state: StatusCardState;
  budgetPause?: BudgetMetric;
  budgetWarning?: readonly BudgetMetric[];
  stoppedReason?: "issue closed";
  /** The Worker's newest known checklist, in its order. Omit when it has not published one. */
  plan?: readonly string[];
  pullRequest?: string;
  harness: "claude" | "codex";
  model: string;
  lastActivityAt: Date;
  now: Date;
  /** Stable outbox id, embedded to recognise and recover the card after a crash. */
  markerId: string;
}

const STATE_LABEL: Record<StatusCardState, string> = {
  working: "Working",
  paused: "Paused",
  stuck: "Stuck",
  recovering: "Recovering",
  done: "Done",
  stopped: "Stopped",
};

/** Renders the exact Markdown stored in and edited on the GitHub status-card comment. */
export function renderStatusCard(card: StatusCard): string {
  const lines = [`## Ostrom: ${card.stoppedReason === "issue closed" ? "Stopped: issue closed" : STATE_LABEL[card.state]}`];
  if (card.budgetPause !== undefined) {
    lines.push("", `Budget reached: ${BUDGET_LABEL[card.budgetPause]}. The operator can extend the budget to resume.`);
  } else if (card.budgetWarning?.length) {
    lines.push("", `Budget warning: nearing the limit for ${card.budgetWarning.map((metric) => BUDGET_LABEL[metric]).join(", ")}.`);
  }
  if (card.plan !== undefined && card.plan.length > 0) {
    lines.push("", "### Plan", ...card.plan.map((item) => `- [ ] ${item}`));
  }
  if (card.pullRequest !== undefined) lines.push("", `PR: ${card.pullRequest}`);
  lines.push(
    "",
    `Harness: \`${card.harness}\` · Model: \`${card.model}\``,
    `Last activity: ${utcMinute(card.lastActivityAt)}`,
    controlsLine(),
    "",
    replyMarker(card.markerId),
  );
  return `${lines.join("\n")}\n`;
}

// An absolute time, because the card is edited only on events: "N min ago" would go stale.
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
