// The Watchdog (docs/direction.md, milestone 1 step 6): a deterministic check over native
// Workers. It checks ticket budgets and runs the two-attempt recovery ladder.
//
// Semon's `stalls` read is the one Semon call Ostrom makes:
//   semon query stalls --idle-minutes <N> --since 1d --json
// Semon lists every native session on this machine whose log has had no line for N minutes and
// that is waiting on a question, whose recorded-busy process is gone, or that is working with no
// output. A Worker's session is matched to its assignment by its git branch
// (`ostrom/ticket-<ticket>-<assignment>`). A failed read is reported and never clears an episode.

import { queueStatusCard } from "../github/cards.ts";
import { MINUTE_MS } from "../worker/budget.ts";
import type { Workers } from "../worker/workers.ts";
import { parseStuckReply, RECOVERY_PROMPT, renderStuckReply, RETRY_PROMPT, stuckDecision } from "./stuck.ts";
import type { ProcessRunner } from "../process.ts";
import type { Store } from "../store/store.ts";

/** The window of session logs Semon reads. */
export const SEMON_WINDOW = "1d";
/** How much of a Worker's open question the stall record keeps. */
export const DETAIL_CHARS = 300;

export interface SemonStall {
  id: string;
  /** The session's git branch; null outside a repository. */
  branch: string | null;
  /** Why Semon calls it stalled: process-gone, waiting-question or no-output at the time of writing. */
  stallReason: string;
  openQuestion: string | null;
  idleMs: number;
}

export class SemonOutputError extends Error {
  override readonly name = "SemonOutputError";
}

export function semonStallsArgs(idleMinutes: number): string[] {
  return ["query", "stalls", "--idle-minutes", String(idleMinutes), "--since", SEMON_WINDOW, "--json"];
}

/** Runs Semon's `stalls` read. A non-zero exit or output that does not parse is an error. */
export async function readSemonStalls(semon: ProcessRunner, idleMinutes: number): Promise<SemonStall[]> {
  const args = semonStallsArgs(idleMinutes);
  const exit = await semon({ args });
  if (exit.code !== 0) {
    const detail = exit.stderr.trim() || exit.stdout.trim() || "no output";
    throw new Error(`semon query stalls exited ${exit.code ?? "by signal"}: ${detail}`);
  }
  return parseSemonStalls(exit.stdout, idleMinutes);
}

/**
 * Parses `semon query stalls --json`, narrowed to the fields the Watchdog reads. Extra fields are
 * ignored; a missing or mistyped field read here throws, as does an answer for another threshold.
 */
export function parseSemonStalls(stdout: string, idleMinutes: number): SemonStall[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new SemonOutputError("semon printed output that is not JSON");
  }
  const root = record(value, "$");
  if (root["idle_minutes"] !== idleMinutes) {
    throw new SemonOutputError(`$.idle_minutes: expected ${idleMinutes}, got ${JSON.stringify(root["idle_minutes"])}`);
  }
  const stalls: unknown = root["stalls"];
  if (!Array.isArray(stalls)) throw new SemonOutputError("$.stalls: expected an array");
  return stalls.map((item: unknown, index: number): SemonStall => {
    const path = `$.stalls[${index}]`;
    const stall = record(item, path);
    const question = stall["open_question"];
    const idleMs = stall["idle_ms"];
    if (typeof idleMs !== "number" || !Number.isSafeInteger(idleMs) || idleMs < 0) {
      throw new SemonOutputError(`${path}.idle_ms: expected a non-negative integer`);
    }
    return {
      idleMs,
      id: string(stall["id"], `${path}.id`),
      branch: stall["branch"] === null ? null : string(stall["branch"], `${path}.branch`),
      stallReason: string(stall["stall_reason"], `${path}.stall_reason`),
      openQuestion:
        question === null ? null : string(record(question, `${path}.open_question`)["text"], `${path}.open_question.text`),
    };
  });
}

export interface WatchdogOptions {
  store: Store;
  semon: ProcessRunner;
  idleMinutes: number;
  workers: Workers;
  now?: Date;
}

export interface Checked {
  assignmentId: number;
  semonReason: string | null;
  /** The open stall episode, or null when the Worker is not stalled. */
  stallId: number | null;
  /** This pass opened the episode. */
  newEpisode: boolean;
  /** The episode this pass cleared, if any. */
  clearedStallId: number | null;
}

export interface WatchdogPass {
  checked: Checked[];
  /** Reads this pass could not do; the command exits non-zero when any is listed. */
  failed: { what: string; error: string }[];
}

/** One pass over running assignments. */
export async function watchdog(options: WatchdogOptions): Promise<WatchdogPass> {
  const { store, idleMinutes, workers, now = new Date() } = options;
  const pass: WatchdogPass = { checked: [], failed: [] };
  const running = store.runningAssignments();
  const queryMinutes = running.reduce((threshold, assignment) => {
    const ticket = store.getTicket(assignment.ticketId);
    return ticket.state === "open" ? Math.min(threshold, Math.max(1, Math.floor(0.8 * ticket.budget.idleMs / MINUTE_MS))) : threshold;
  }, idleMinutes);
  let semon: SemonStall[] | null;
  try {
    semon = await readSemonStalls(options.semon, queryMinutes);
  } catch (error) {
    semon = null;
    pass.failed.push({ what: "semon stalls", error: message(error) });
  }
  for (const { id } of running) {
    const assignment = store.getAssignment(id);
    if (assignment.state !== "running") continue;
    const ticket = store.getTicket(assignment.ticketId);
    if (ticket.state !== "open" || assignment.sessionId === null) continue;
    if (ticket.budgetResume) {
      workers.resumeBudget(assignment.id);
      continue;
    }
    const matched = semon?.find((stall) => stall.branch === assignment.branch && stall.id === assignment.sessionId);
    const lastTurn = assignment.lastTurnAt === null ? null : Date.parse(assignment.lastTurnAt);
    const turnStart = assignment.turnStartedAt === null ? null : Date.parse(assignment.turnStartedAt);
    // A result from before the present turn must not interrupt the present turn.
    const idleMs = matched?.stallReason === "no-output" && turnStart !== null && now.getTime() - matched.idleMs >= turnStart ?
      matched.idleMs : 0;
    if (workers.enforceBudget(assignment.id, idleMs)) continue;
    const failed = assignment.outcome === "failed" || assignment.outcome === "cancelled";
    const checkAt = turnStart ?? lastTurn;
    const fresh = matched !== undefined && matched.idleMs >= idleMinutes * MINUTE_MS &&
      (checkAt === null || now.getTime() - checkAt >= idleMinutes * MINUTE_MS);
    const reason = fresh ? matched.stallReason : failed && turnStart === null ? "turn failed" : null;
    const checked: Checked = {
      assignmentId: assignment.id, semonReason: fresh ? matched.stallReason : null,
      stallId: null, newEpisode: false, clearedStallId: null,
    };
    pass.checked.push(checked);
    let stall = store.openStall(assignment.id);
    if (reason !== null && stall === null) {
      const question = matched?.openQuestion ?? null;
      const detail = question !== null && question.length > DETAIL_CHARS ? `${question.slice(0, DETAIL_CHARS)}…` : question;
      const recorded = store.recordStall({ assignmentId: assignment.id, semonReason: reason, detail });
      checked.newEpisode = !recorded.duplicate;
      stall = store.getStall(recorded.id);
    }
    if (stall !== null) {
      checked.stallId = stall.id;
      // Semon omits sessions until they are idle long enough. Absence during that window
      // after a recovery turn is not evidence of progress.
      const settled = reason !== null || (semon !== null && turnStart === null &&
        (lastTurn === null || now.getTime() - lastTurn >= idleMinutes * MINUTE_MS));
      const action = stuckDecision(stall.attempts, stall.blockedAt !== null, reason !== null, settled);
      if (action === "recover") {
        const stallId = stall.id;
        const prompt = stall.attempts === 0 ? RECOVERY_PROMPT : RETRY_PROMPT;
        workers.recoverStall(assignment.id, stallId, prompt, turnStart !== null, (result, workerStore) => {
          try {
            parseStuckReply(result.text);
            workerStore.saveRecoveryReply(stallId, result.text);
          } catch {
            // A Worker that cannot supply the template still gets an evidence-based reply.
          }
        });
      } else if (action === "block" && turnStart !== null) {
        workers.interrupt(assignment.id);
      } else if (action === "block") {
        const context = store.ticketContext(ticket.id);
        const cause = stall.semonReason === "waiting-question" ? "The Worker is waiting for an answer." :
          stall.semonReason === "process-gone" ? "The Worker process stopped responding." :
          stall.semonReason === "no-output" ? "The Worker stopped producing output." : "The Worker turn failed.";
        const fallback = {
          trying: `Complete the work requested in ${context.thread.url}.`,
          blockedBy: cause,
          tried: "Attempted to recover twice on the same session.",
          options: ["Provide the missing information or redirect the work.", "Ask Ostrom to stop with `@ostrom stop`."],
          work: "Ostrom could not verify a pushed checkpoint.",
        };
        const reply = parseStuckReply(stall.recoveryReply ?? JSON.stringify(fallback));
        store.blockStall(stall.id, renderStuckReply(reply));
      } else if (action === "clear") {
        checked.clearedStallId = store.clearStall(assignment.id);
      }
    }
    queueStatusCard(store, ticket.id, now, idleMs);
  }
  return pass;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SemonOutputError(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new SemonOutputError(`${path}: expected a string, got ${JSON.stringify(value)}`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
