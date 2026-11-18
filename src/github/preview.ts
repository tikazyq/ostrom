// Markdown preview of the next outbox send pass. It is deliberately read-only: the same pending
// records and batching rules feed the real sender, so developers can inspect delivery before a tick.

import { budgetReached } from "../budget/budgets.ts";
import type { Reply, Store } from "../store/store.ts";
import type { GhRunner } from "./gh.ts";
import { mergeEvidenceBlock } from "./merge-eligibility.ts";
import { readMergeEvidence, type MergeEvidence } from "./merge-evidence.ts";
import type { MergePolicy } from "./merge-policy.ts";

export function renderPreview(store: Store, now = new Date()): string {
  const rows = store.pendingReplies();
  if (rows.length === 0) return "# Ostrom preview\n\nNothing to send.\n";
  return ["# Ostrom preview", "", ...rows.map((reply) => render(reply, store, now))].join("\n\n");
}

/** Extend the outbox preview with a live read of the PRs already observed on Worker tickets. */
export async function renderMergePreview(store: Store, gh: GhRunner, repo: string, base: string, policy: MergePolicy): Promise<string> {
  const outbox = renderPreview(store);
  const evidence = new Map<number, MergeEvidence | Error>();
  const candidates = store.runningAssignments().flatMap((assignment) => assignment.branch === null ? [] :
    store.ticketPullRequests(assignment.ticketId, repo).map(({ number }) => ({ assignment, number })));
  for (const { number } of candidates) {
    if (evidence.has(number)) continue;
    try {
      evidence.set(number, await readMergeEvidence(gh, repo, number, policy));
    } catch (error) {
      evidence.set(number, error instanceof Error ? error : new Error(String(error)));
    }
  }

  const now = new Date();
  const rows = candidates.map(({ assignment, number }) => {
    const ticket = store.getTicket(assignment.ticketId);
    const budget = budgetReached(store.ticketBudget(ticket.id), now);
    const read = evidence.get(number)!;
    let result: string | null;
    if (read instanceof Error) result = `evidence unreadable (${read.message})`;
    else {
      result = mergeEvidenceBlock(read, policy);
      if (result === null && (read.pr.head.name !== assignment.branch || read.pr.base.name !== base)) {
        result = "PR does not match the Worker branch and configured base";
      }
      if (result === null && candidates.some((other) => other.assignment.id !== assignment.id && other.number === number)) {
        result = "multiple assignments track this PR";
      }
      if (result === null && candidates.some((other) => {
        const otherRead = evidence.get(other.number);
        return other.number !== number && other.assignment.branch === assignment.branch &&
          (otherRead instanceof Error || (otherRead?.pr.state === "open" && otherRead.pr.head.name === assignment.branch));
      })) result = "multiple tracked PRs may be open on this branch";
    }
    if (ticket.state !== "open") result = `ticket is ${ticket.state}${result === null ? "" : ` (GitHub: ${result})`}`;
    if (budget !== null) result = `${result === null ? "" : `${result}, `}ticket budget reached (${budget})`;
    const status = result === null ? "tracked checks pass" : `blocked — ${result}`;
    const github = read instanceof Error ? "unavailable" : `${read.mergeState}, CI ${read.rollupState ?? "unavailable"}`;
    return `- Ticket ${ticket.id}, PR #${number} — ${status}. Ticket ${ticket.state}, budget ${budget ?? "within limits"}, GitHub ${github}.`;
  });
  return [outbox.trimEnd(), "", "## Merge eligibility (preview only)", "", `Policy: ${policy.strategy}.`,
    "Issue state, stop state, quiet window and idle state: not yet tracked.", "",
    ...(rows.length === 0 ? ["No tracked Worker PRs."] : rows), ""].join("\n");
}

function render(reply: Reply, store: Store, now: Date): string {
  const thread = store.getThread(reply.threadId);
  const destination = `${thread.url} (${thread.kind} #${thread.number})`;
  if (reply.kind === "comment") return `## Comment on ${destination}\n\n${reply.body}`;
  if (reply.kind === "edit") return `## Edit status card on ${destination}\n\n${reply.body}`;
  if (reply.kind === "reaction") return `## React ${reply.reaction} on ${reply.target}\n\nReceived ${minutesAgo(reply.enqueuedAt, now)} min ago.`;
  return `## Label on ${destination}\n\n${reply.body}`;
}

function minutesAgo(at: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
}
