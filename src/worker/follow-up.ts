// Thread subscription: a new trigger on a subscribed thread goes straight to its Worker's
// session. A submitted review and all of its inline comments are one logical follow-up: one turn,
// one acknowledgement reaction, and one summary reply after the Worker completes.

import { parseComment } from "../commands/parser.ts";
import { queueStatusCard } from "../github/cards.ts";
import type { Store, Thread, Trigger } from "../store/store.ts";
import type { Workers } from "./workers.ts";

export interface Delivered {
  triggerId: number;
  ticketId: number;
  assignmentId: number;
}

export interface RoutePass {
  queued: Delivered[];
  failed: { triggerId: number; ticketId: number; error: string }[];
}

export function routeFollowUps(store: Store, workers: Workers): RoutePass {
  const pass: RoutePass = { queued: [], failed: [] };
  const pending = store.pendingDeliveries();
  const grouped = new Set<string>();
  for (const delivery of pending) {
    const { trigger, ticketId, assignmentId } = delivery;
    if (trigger.kind === "issue_state" || (trigger.kind === "issue_comment" && parseComment(trigger.body ?? "").kind === "command")) continue;
    if (assignmentId === null) {
      pass.failed.push({ triggerId: trigger.id, ticketId, error: `ticket ${ticketId} has no running Worker` });
      continue;
    }
    const reviewId = trigger.reviewId;
    const key = reviewId === undefined ? `${trigger.id}:${assignmentId}` : `review-${ticketId}:${assignmentId}:${reviewId}`;
    if (grouped.has(key)) continue;
    grouped.add(key);
    const triggers = reviewId === undefined ? [trigger] : pending.filter((item) =>
      item.ticketId === ticketId && item.assignmentId === assignmentId && item.trigger.reviewId === reviewId,
    ).map((item) => item.trigger);
    if (reviewId !== undefined && !triggers.some((item) => item.kind === "pull_request_review")) continue;
    const thread = store.getThread(trigger.threadId);
    const added = store.atomic(() => {
      const queued = workers.deliver(
        assignmentId, key,
        reviewId === undefined ? followUpMessage(ticketId, trigger, thread) : reviewFollowUpMessage(ticketId, thread, triggers),
        { kind: "work", effect: {
          kind: "delivery", triggerIds: triggers.map((item) => item.id), reaction: "received",
          ...(reviewId === undefined ? {} : { review: { threadId: thread.id, reviewId } }),
        } },
      );
      const cleared = store.clearStallForHumanReply(assignmentId);
      // Only the public stuck step pauses the ticket; a silent recovery leaves it open.
      if (cleared !== null && store.getStall(cleared).publicAt !== null) {
        store.resumeTicket(ticketId);
        queueStatusCard(store, ticketId);
      }
      return queued;
    });
    if (added) pass.queued.push({ triggerId: trigger.id, ticketId, assignmentId });
  }
  return pass;
}

const KIND_NOUNS: Record<string, string> = {
  issue_comment: "comment",
  pull_request_review_comment: "review comment",
  pull_request_review: "review",
};

/** A non-review follow-up remains a summary and pointer rather than duplicating GitHub content. */
export function followUpMessage(ticketId: number, trigger: Trigger, thread: Thread, instruction = true): string {
  const noun = KIND_NOUNS[trigger.kind] ?? trigger.kind;
  const on = thread.kind === "issue" ? "issue" : "pull request";
  return [
    `Follow-up for Ostrom ticket ${ticketId}: a new ${noun} (${trigger.kind}) by @${trigger.actor}${instruction ? "" : " (information, not an instruction)"}`,
    `on ${on} #${thread.number}: ${trigger.url}`,
    "",
    "Read it with `gh`; this message does not copy it. If it asks for changes, make them and push",
    "to the branch of your existing pull request; do not open a new one. Do not comment on GitHub",
    "yourself: Ostrom replies to people.",
  ].join("\n");
}

/** The complete submitted review is one Worker turn, with every inline comment and its location. */
export function reviewFollowUpMessage(ticketId: number, thread: Thread, triggers: readonly Trigger[]): string {
  const review = triggers.find((trigger) => trigger.kind === "pull_request_review") ?? triggers[0]!;
  const comments = triggers.filter((trigger) => trigger.kind === "pull_request_review_comment");
  const lines = [
    `Review follow-up for Ostrom ticket ${ticketId} on pull request #${thread.number}: ${review.url}`,
    `Reviewer: @${review.actor}`,
    "",
    "Review body:",
    review.kind === "pull_request_review" ? (review.body ?? "") : "(no review body)",
    "",
    "Inline comments:",
    ...comments.flatMap((comment, index) => [
      `${index + 1}. ${comment.path ?? "unknown path"}:${comment.line ?? "unknown line"}`,
      comment.body ?? "",
    ]),
    "",
    "Address the review. Ostrom will post one summary reply using your final answer; do not comment on GitHub yourself.",
  ];
  return lines.join("\n");
}
