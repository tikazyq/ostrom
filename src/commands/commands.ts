import { randomUUID } from "node:crypto";
import { queueStatusCard } from "../github/cards.ts";
import { ghGet, type GhRunner } from "../github/gh.ts";
import type { Store, Trigger } from "../store/store.ts";
import { pullRequestsForBranch } from "../worker/dispatch.ts";
import { followUpMessage } from "../worker/follow-up.ts";
import type { Workers } from "../worker/workers.ts";
import { parseComment } from "./parser.ts";

export interface CommandPass {
  handled: { triggerId: number; ticketId: number; command: string; allowed: boolean }[];
  failed: { triggerId: number; ticketId: number; error: string }[];
}

/** Operator controls share the Worker delivery and durable state transitions used by GitHub commands. */
const PAUSE_PROMPT = "Pause this ticket after the current work finishes. Push your work in progress, then stop and wait for Ostrom to resume you.";
const RESUME_PROMPT = "This ticket has resumed. Continue your work.";
const STOP_PROMPT = "Stop this ticket gracefully. Push your work in progress and summarise precisely where you stopped.";

export function operatorControls(store: Store, workers: Workers): {
  pause(ticketId: number): Promise<void>;
  resume(ticketId: number): Promise<void>;
  stop(ticketId: number): Promise<void>;
} {
  const running = (ticketId: number) => {
    const assignment = store.latestAssignment(ticketId);
    if (assignment?.state !== "running") throw new Error(`ticket ${ticketId} has no running Worker`);
    return assignment;
  };
  return {
    async pause(ticketId) {
      const assignment = running(ticketId);
      store.atomic(() => {
        workers.deliver(assignment.id, `operator-pause-${randomUUID()}`, PAUSE_PROMPT, { kind: "control" });
        store.pauseTicket(ticketId);
        queueStatusCard(store, ticketId);
      });
    },
    async resume(ticketId) {
      const assignment = running(ticketId);
      store.atomic(() => {
        workers.deliver(assignment.id, `operator-resume-${randomUUID()}`, RESUME_PROMPT, { kind: "control" });
        store.resumeTicket(ticketId);
        queueStatusCard(store, ticketId);
      });
    },
    async stop(ticketId) {
      const assignment = running(ticketId);
      const firstStop = store.stopRequestedAt(ticketId) === null;
      workers.deliver(assignment.id, `operator-stop-${randomUUID()}`, STOP_PROMPT, {
        kind: "stop",
        effect: {
          kind: "stop", reason: "stopped by operator", replyId: `operator-stopped-${ticketId}`,
          threadId: store.ticketContext(ticketId).thread.id,
        },
      });
      if (firstStop) workers.cancel(assignment.id);
    },
  };
}

/**
 * Applies controls and routes redirects on subscribed threads before ordinary follow-up routing.
 */
export async function routeCommands(
  store: Store,
  workers: Workers,
  gh: GhRunner,
  repo: string,
): Promise<CommandPass> {
  const pass: CommandPass = { handled: [], failed: [] };
  const permissions = new Map<string, Promise<boolean>>();
  const authors = new Map<number, Promise<string>>();
  for (const pending of store.pendingCommands()) {
    const parsed = parseComment(pending.trigger.body ?? "");
    const command = pending.trigger.kind === "issue_state" ?
      (pending.trigger.body === "closed" ? (store.getThread(pending.trigger.threadId).kind === "issue" ? "close_issue" : "close_pull_request") : "ignore_issue_state") :
      parsed.kind === "command" ? parsed.command : "redirect";
    try {
      if (command === "ignore_issue_state") {
        store.recordCommandReceipt(pending.trigger.id, pending.ticketId, command, false);
        pass.handled.push({ triggerId: pending.trigger.id, ticketId: pending.ticketId, command, allowed: true });
        continue;
      }
      const allowed = command === "redirect" || command === "close_issue" || command === "close_pull_request" || await mayControl(
        store, gh, repo, pending.trigger, pending.ticketId, permissions, authors,
      );
      if (!allowed) {
        store.recordCommandReceipt(pending.trigger.id, pending.ticketId, "forbidden", false);
        enqueueReaction(store, pending.trigger, "confused");
        pass.handled.push({ triggerId: pending.trigger.id, ticketId: pending.ticketId, command, allowed });
        continue;
      }
      if (command === "close_pull_request") {
        const assignment = store.latestAssignment(pending.ticketId);
        if (assignment?.state !== "running") throw new Error(`ticket ${pending.ticketId} has no running Worker`);
        // GitHub reports a merged PR as closed. A merge is the work done, which the Router's outcome
        // pass reports and which ends the ticket, so only a PR closed without merging ends the attempt.
        const number = store.getThread(pending.trigger.threadId).number;
        const merged = (await pullRequestsForBranch(gh, repo, assignment.branch!))
          .some((pr) => pr.number === number && pr.state === "merged");
        store.atomic(() => {
          if (!merged) {
            store.unsubscribeTicket(pending.ticketId);
            store.endAssignment(assignment.id, "pull request closed");
            queueStatusCard(store, pending.ticketId);
          }
          store.recordCommandReceipt(pending.trigger.id, pending.ticketId, command, true);
        });
        if (!merged) workers.cancel(assignment.id);
      } else {
        const { trigger, ticketId } = pending;
        const instruction = command !== "redirect" || await collaborator(gh, repo, trigger.actor, permissions);
        const assignment = store.latestAssignment(ticketId);
        if (assignment?.state !== "running") throw new Error(`ticket ${ticketId} has no running Worker`);
        const stopping = command === "stop" || command === "close_issue";
        const firstStop = stopping && store.stopRequestedAt(ticketId) === null;
        store.atomic(() => {
          if (stopping) {
            const closed = command === "close_issue";
            workers.deliver(assignment.id, `${command}-${trigger.id}`, closed
              ? "The issue was closed. Stop this ticket gracefully, push your work in progress, and summarise precisely where you stopped."
              : STOP_PROMPT, {
              kind: "stop",
              effect: {
                kind: "stop", threadId: trigger.threadId,
                reason: closed ? "issue closed" : "stopped by command",
                replyId: closed ? `stopped-issue-closed-${ticketId}` : `stopped-${ticketId}`,
              },
            });
            if (!closed) enqueueReaction(store, trigger, "+1");
          } else if (command === "redirect") {
            workers.deliver(assignment.id, `${trigger.id}:${assignment.id}`,
              followUpMessage(ticketId, trigger, store.getThread(trigger.threadId), instruction),
              { kind: "work", effect: { kind: "delivery", triggerIds: [trigger.id], reaction: "command-eyes" } },
            );
          } else {
            workers.deliver(assignment.id, `${command}-${trigger.id}`, command === "pause" ? PAUSE_PROMPT : RESUME_PROMPT,
              { kind: "control" });
            if (command === "pause") store.pauseTicket(ticketId);
            else store.resumeTicket(ticketId);
            enqueueReaction(store, trigger, "+1");
            queueStatusCard(store, ticketId);
          }
          store.recordCommandReceipt(trigger.id, ticketId, command, instruction);
        });
        if (firstStop) workers.cancel(assignment.id);
      }
      pass.handled.push({ triggerId: pending.trigger.id, ticketId: pending.ticketId, command, allowed });
    } catch (error) {
      pass.failed.push({ triggerId: pending.trigger.id, ticketId: pending.ticketId, error: message(error) });
    }
  }
  return pass;
}

async function mayControl(
  store: Store,
  gh: GhRunner,
  repo: string,
  trigger: Trigger,
  _ticketId: number,
  permissions: Map<string, Promise<boolean>>,
  authors: Map<number, Promise<string>>,
): Promise<boolean> {
  const thread = store.getThread(trigger.threadId);
  const author = authors.get(thread.id) ?? issueAuthor(gh, repo, thread.number);
  authors.set(thread.id, author);
  return trigger.actor.toLowerCase() === (await author).toLowerCase() || collaborator(gh, repo, trigger.actor, permissions);
}

async function collaborator(gh: GhRunner, repo: string, user: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const key = user.toLowerCase();
  const found = cache.get(key) ?? ghGet(gh, `repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`).then((body) => {
    // `permission` is the legacy level, where triage reads as "read"; `role_name` is the real role.
    const { permission, role_name: role } = body as { permission?: unknown; role_name?: unknown };
    return role === "triage" || role === "write" || role === "maintain" || role === "admin" ||
      permission === "write" || permission === "admin";
  }).catch(() => false);
  cache.set(key, found);
  return found;
}

async function issueAuthor(gh: GhRunner, repo: string, number: number): Promise<string> {
  const issue = await ghGet(gh, `repos/${repo}/issues/${number}`) as { user?: { login?: unknown } };
  return typeof issue.user?.login === "string" ? issue.user.login : "";
}

function enqueueReaction(store: Store, trigger: Trigger, reaction: "+1" | "confused"): void {
  if (trigger.kind === "pull_request_review") return;
  store.enqueueReply({ id: `command-${reaction}-${trigger.id}`, threadId: trigger.threadId, body: "", kind: "reaction", target: trigger.url, reaction });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
