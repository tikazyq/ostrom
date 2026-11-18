// Native Workers (docs/direction.md, milestone 1 PR 2): each Worker is a Claude Code or Codex
// session started and resumed by ID through the session runner. Turns on one session run one at a
// time; a follow-up queues behind the running turn. Everything here is deterministic.

import { basename, join } from "node:path";

import { turnBudgetReached } from "../budget/budgets.ts";
import { queueStatusCard } from "../github/cards.ts";
import { renderReviewReply } from "../github/review-reply.ts";
import { execGh, ghGet, type GhRunner } from "../github/gh.ts";
import { parseStuckReply, renderStuckReply } from "../watchdog/stuck.ts";
import type { WorkerConfig } from "../ostromd/config.ts";
import { rolloutModel } from "../session/rollout.ts";
import type { Runner, Session, TurnResult } from "../session/runner.ts";
import { createWorktree } from "../session/worktree.ts";
import type { Assignment, AssignmentOutcome, QueuedTurn, TurnEffects, Store } from "../store/store.ts";
import { workerBrief } from "./dispatch.ts";

export interface Dispatched {
  assignmentId: number;
  sessionId: string;
  branch: string;
}

export interface WorkersDeps {
  store: Store;
  config: WorkerConfig;
  runners: Record<"claude" | "codex", Runner>;
  /** Where Codex writes rollout records; set to verify the Worker's model after each Codex turn. */
  codexSessions?: string;
  addWorktree?: typeof createWorktree;
  log?: (line: string) => void;
  gh?: GhRunner;
}

/** The writable Git metadata for a linked worktree's ordinary commits. */
export function gitDirs(repo: string, worktree: string): string[] {
  const git = join(repo, ".git");
  return [
    join(git, "objects"),
    join(git, "refs"),
    join(git, "logs"),
    join(git, "worktrees", basename(worktree)),
  ];
}

/** Turns that run even on a paused ticket: those that pause it, and those that stop it. */
const RUNS_WHILE_PAUSED = ["recovery-", "budget-pause-", "stuck-", "operator-pause-", "pause-", "operator-stop-", "stop-", "close-issue-"];

export const INTERRUPTED_PROMPT =
  "You were interrupted while working on this ticket. Check your state (git status, your branch and " +
  "pull request) and continue where you stopped.";

export class Workers {
  readonly #deps: WorkersDeps;
  readonly #sessions = new Map<number, Session>();
  readonly #chains = new Map<number, Promise<void>>();
  readonly #scheduled = new Set<number>();
  readonly #callbacks = new Map<number, {
    onStart: (turnId: string) => void;
    onComplete?: (result: TurnResult) => void | Promise<void>;
  }>();
  readonly #budgetPauses = new Set<number>();
  readonly #inFlight = new Map<number, AbortController>();
  #stopping = false;

  constructor(deps: WorkersDeps) {
    this.#deps = deps;
  }

  /**
   * Creates the ticket's worktree and assignment, starts the session with the Worker brief and
   * returns once its ID is known and stored; the turn goes on in the background (see `drain`).
   * A session that does not start ends the assignment with the error as its reason and rethrows.
   */
  async dispatch(ticketId: number): Promise<Dispatched> {
    const { store, config } = this.#deps;
    const context = store.ticketContext(ticketId);
    const id = store.createAssignment(ticketId);
    try {
      const path = join(config.worktrees, `ticket-${ticketId}-${id}`);
      const branch = await (this.#deps.addWorktree ?? createWorktree)(config.repo, path, config.base, ticketId, id);
      store.configureNativeAssignment(id, { harness: config.harness, model: config.model, worktree: path, branch, machine: config.machine });
      let resolve!: (sessionId: string) => void;
      const started = new Promise<string>((r) => (resolve = r));
      const session = this.#deps.runners[config.harness].start({
        cwd: path,
        model: config.model,
        writableDirs: gitDirs(config.repo, path),
        onSessionId: (sessionId) => {
          store.startNativeAssignment(id, sessionId);
          store.beginTurn(id);
          queueStatusCard(store, ticketId);
          this.#sessions.set(id, session);
          resolve(sessionId);
        },
      });
      const turn = this.#enqueue(id, () => this.#firstTurn(id, session, workerBrief(context, branch, config.base, config.rules)));
      await Promise.race([started, turn]);
      const assignment = store.getAssignment(id);
      if (assignment.state === "ended") throw new Error(assignment.endReason ?? "the session did not start");
      return { assignmentId: id, sessionId: assignment.sessionId!, branch };
    } catch (error) {
      if (store.getAssignment(id).state === "pending") {
        store.abandonAssignment(id, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  /** Persist before returning so callers can safely record their command receipt. Effects restore
   * the daemon's callbacks after restart; live callbacks remain attached when work is deferred. */
  deliver(
    assignmentId: number,
    key: string,
    prompt: string,
    onStart: (turnId: string) => void,
    onComplete?: (result: TurnResult) => void | Promise<void>,
    effects: TurnEffects = {},
  ): boolean {
    const turn = this.#deps.store.queueTurn(assignmentId, key, prompt, effects);
    if (turn === null) {
      this.schedule(assignmentId);
      return false;
    }
    this.#callbacks.set(turn.id, { onStart, ...(onComplete === undefined ? {} : { onComplete }) });
    this.schedule(assignmentId);
    return true;
  }

  /** Retry deferred turns after resume or explicit reservation release, without replacing callbacks. */
  schedule(assignmentId: number): void {
    for (const turn of this.#deps.store.queuedTurns(assignmentId)) {
      if (this.#scheduled.has(turn.id)) continue;
      this.#scheduled.add(turn.id);
      void this.#enqueue(assignmentId, async () => {
        try {
          await this.#queuedTurn(turn);
        } catch (error) {
          this.#deps.log?.(`queued turn ${turn.id}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.#scheduled.delete(turn.id);
        }
      });
    }
  }

  async #queuedTurn(turn: QueuedTurn): Promise<void> {
    if (this.#stopping) return;
    const { store } = this.#deps;
    const assignment = store.getAssignment(turn.assignmentId);
    if (assignment.state !== "running" && turn.state !== "completed") {
      store.finishQueuedTurn(turn.id);
      this.#callbacks.delete(turn.id);
      return;
    }
    const callbacks = this.#callbacks.get(turn.id);
    const complete = async (result: TurnResult) => {
      if (callbacks?.onComplete !== undefined) await callbacks.onComplete(result);
      else await this.#restoreCompletion(turn, result);
      store.finishQueuedTurn(turn.id);
      this.#callbacks.delete(turn.id);
      queueStatusCard(store, assignment.ticketId);
    };
    if (turn.state === "completed") {
      await complete(turn.result!);
      return;
    }
    await this.#turn(turn.assignmentId, turn.prompt, (turnId) => {
      store.startQueuedTurn(turn.id);
      if (callbacks !== undefined) callbacks.onStart(turnId);
      else if (turn.effects.deliveries !== undefined) {
        store.recordReviewDelivery(turn.effects.deliveries.triggerIds, turn.assignmentId, turnId);
        for (const reply of turn.effects.deliveries.reactions) store.enqueueReply(reply);
      }
    }, complete, turn.key, turn.id);
    if (!this.#stopping && store.queuedTurns(turn.assignmentId).some((item) => item.id === turn.id && item.state === "running")) {
      store.finishQueuedTurn(turn.id);
      this.#callbacks.delete(turn.id);
    }
  }

  async #restoreCompletion(turn: QueuedTurn, result: TurnResult): Promise<void> {
    const { store } = this.#deps;
    const { reviewReply, stop, stuckReply } = turn.effects;
    if (reviewReply !== undefined) store.enqueueReply({ ...reviewReply, body: renderReviewReply(result.text) });
    if (stuckReply !== undefined) {
      store.enqueueReply({ id: `stuck-${stuckReply.stallId}`, threadId: stuckReply.threadId,
        body: renderStuckReply(parseStuckReply(result.text, stuckReply.cause)), blocking: true });
    }
    if (stop !== undefined) {
      const assignment = store.getAssignment(turn.assignmentId);
      const repo = store.ticketContext(assignment.ticketId).source.name;
      const gh = this.#deps.gh ?? execGh;
      const owner = repo.split("/")[0]!;
      const prs = await ghGet(gh, `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${assignment.branch!}`)}&state=open&per_page=100`);
      if (!Array.isArray(prs)) throw new Error("expected open pull requests");
      for (const pr of prs as { html_url: string }[]) await gh(["pr", "ready", "--undo", pr.html_url]);
      store.finishStop(assignment.id, stop.reason, { id: stop.replyId, threadId: stop.threadId, body: result.text, blocking: true });
    }
    queueStatusCard(store, store.getAssignment(turn.assignmentId).ticketId);
  }

  /** Cancels the turn currently running for an assignment, if any. */
  cancel(assignmentId: number): boolean {
    const controller = this.#inFlight.get(assignmentId);
    if (controller === undefined || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /**
   * For an ostromd shutdown: cuts off every running turn and starts no queued one. A cut-off turn
   * stays open in the store, so the next start resumes it by session ID (`recover`), as after a crash.
   */
  stop(): void {
    this.#stopping = true;
    for (const controller of this.#inFlight.values()) controller.abort();
  }

  /**
   * Run once at start. A native assignment that never got a session ends; the others resume by
   * session ID, and one whose turn was cut off is sent a turn to check its state and go on.
   */
  recover(): { resumed: number[]; interrupted: number[]; abandoned: number[] } {
    const { store } = this.#deps;
    const pass = { resumed: [] as number[], interrupted: [] as number[], abandoned: [] as number[] };
    for (const pending of store.pendingAssignments()) {
      store.abandonAssignment(pending.id, "ostromd stopped before the session started");
      pass.abandoned.push(pending.id);
    }
    for (const assignment of store.runningAssignments()) {
      if (assignment.sessionId === null) continue;
      this.#session(assignment);
      pass.resumed.push(assignment.id);
      const queued = store.queuedTurns(assignment.id);
      if (assignment.turnStartedAt !== null) {
        const turnId = `${assignment.sessionId}:${assignment.turns}`;
        const reviews = queued.some((turn) => turn.effects.reviewReply !== undefined) ? [] : store.reviewDeliveries(assignment.id, turnId);
        store.recordInterruption(assignment.id);
        pass.interrupted.push(assignment.id);
        void this.#enqueue(assignment.id, () => this.#turn(assignment.id, INTERRUPTED_PROMPT, undefined, (result) => {
          for (const review of reviews) {
            store.enqueueReply({
              id: `review-${assignment.id}-${review.reviewId}`,
              threadId: review.threadId,
              body: renderReviewReply(result.text),
            });
          }
        }, "recovery-interrupted"));
      }
      for (const turn of queued) store.rescheduleTurn(turn.id);
      this.schedule(assignment.id);
    }
    for (const id of store.queuedAssignmentIds()) this.schedule(id);
    return pass;
  }

  /** Resolves when every queued and running turn has finished. */
  async drain(): Promise<void> {
    while (this.#chains.size > 0) await Promise.all([...this.#chains.values()]);
  }

  #session(assignment: Assignment): Session {
    let session = this.#sessions.get(assignment.id);
    if (session === undefined) {
      session = this.#deps.runners[assignment.harness!].resume({
        cwd: assignment.worktree!,
        model: assignment.model!,
        sessionId: assignment.sessionId!,
        writableDirs: gitDirs(this.#deps.config.repo, assignment.worktree!),
      });
      this.#sessions.set(assignment.id, session);
    }
    return session;
  }

  #enqueue(id: number, job: () => Promise<void>): Promise<void> {
    const next = (this.#chains.get(id) ?? Promise.resolve()).then(job);
    this.#chains.set(id, next);
    void next.finally(() => {
      if (this.#chains.get(id) === next) this.#chains.delete(id);
    });
    return next;
  }

  async #firstTurn(id: number, session: Session, prompt: string): Promise<void> {
    const { store } = this.#deps;
    const controller = new AbortController();
    this.#inFlight.set(id, controller);
    let result: TurnResult;
    try {
      result = await session.send(prompt, controller.signal);
    } catch (error) {
      if (this.#stopping) return;
      if (controller.signal.aborted) {
        store.endTurn(id, null);
        store.clearTurnError(id);
      } else if (store.getAssignment(id).state === "pending") {
        store.abandonAssignment(id, error instanceof Error ? error.message : String(error));
      } else {
        this.#failed(id, error);
      }
      return;
    } finally {
      if (this.#inFlight.get(id) === controller) this.#inFlight.delete(id);
    }
    if (this.#stopping) return;
    this.#finished(id, result);
  }

  async #turn(
    id: number,
    prompt: string,
    onStart?: (turnId: string) => void,
    onComplete?: (result: TurnResult) => void | Promise<void>,
    key = "",
    queuedId?: number,
  ): Promise<void> {
    const { store } = this.#deps;
    const assignment = store.getAssignment(id);
    if (this.#stopping || assignment.state !== "running" || store.mergeReserved(id)) return;
    const ticket = store.getTicket(assignment.ticketId);
    if (ticket.state === "paused" && !RUNS_WHILE_PAUSED.some((prefix) => key.startsWith(prefix))) return;
    const session = this.#session(assignment);
    const turn = store.beginTurn(id);
    onStart?.(`${assignment.sessionId}:${turn}`);
    const controller = new AbortController();
    this.#inFlight.set(id, controller);
    let result: TurnResult;
    try {
      result = await session.send(prompt, controller.signal);
    } catch (error) {
      if (this.#stopping) return;
      if (controller.signal.aborted) {
        store.endTurn(id, null);
        store.clearTurnError(id);
      } else {
        this.#failed(id, error);
      }
      return;
    } finally {
      if (this.#inFlight.get(id) === controller) this.#inFlight.delete(id);
    }
    if (this.#stopping) return;
    const persisted = result.status === "completed" && queuedId !== undefined;
    if (persisted) store.completeQueuedTurn(queuedId, id, result);
    this.#finished(id, result, persisted);
    if (result.status === "completed") await onComplete?.(result);
  }

  #failed(id: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#deps.log?.(`assignment ${id}: turn failed: ${message}`);
    this.#deps.store.endTurn(id, null);
    this.#deps.store.recordTurnError(id, message);
    this.#mark(id, "failed");
    queueStatusCard(this.#deps.store, this.#deps.store.getAssignment(id).ticketId);
  }

  #finished(id: number, result: TurnResult, persisted = false): void {
    const { store } = this.#deps;
    if (!persisted) store.endTurn(id, result.usage);
    store.clearTurnError(id);
    const assignment = store.getAssignment(id);
    if (assignment.state !== "running") return;
    if (result.status === "cancelled") {
      queueStatusCard(store, assignment.ticketId);
      return;
    }
    const reached = turnBudgetReached(store.ticketBudget(assignment.ticketId), new Date());
    if (store.getTicket(assignment.ticketId).state === "open" && reached !== null && !this.#budgetPauses.has(id)) {
      this.#budgetPauses.add(id);
      store.pauseTicketForBudget(assignment.ticketId, reached);
      this.deliver(
        id,
        `budget-pause-${assignment.ticketId}-${reached}`,
        "The ticket budget has been reached. Push your work in progress, then stop and wait for Ostrom to resume you.",
        () => {},
      );
      queueStatusCard(store, assignment.ticketId);
      return;
    }
    if (store.getTicket(assignment.ticketId).state === "open") this.#budgetPauses.delete(id);
    if (assignment.harness === "codex" && this.#deps.codexSessions !== undefined) {
      const reason = this.#modelProblem(assignment, this.#deps.codexSessions);
      if (reason !== null) {
        this.#deps.log?.(`assignment ${id}: ended: ${reason}`);
        store.endAssignment(id, reason);
        return;
      }
    }
    // Ostrom only aborts a turn to replace it. That cancellation is bookkeeping, not a terminal
    // Worker outcome: the next queued turn must still run on this assignment.
    this.#mark(id, null);
    queueStatusCard(store, assignment.ticketId);
  }

  /** Records an outcome unless the Router ended the assignment while the turn ran. */
  #mark(id: number, outcome: AssignmentOutcome | null): void {
    if (this.#deps.store.getAssignment(id).state === "running") this.#deps.store.recordOutcome(id, outcome);
  }

  #modelProblem(assignment: Assignment, root: string): string | null {
    let model: string;
    try {
      model = rolloutModel(root, assignment.sessionId!);
    } catch (error) {
      return `model unverified: ${error instanceof Error ? error.message : String(error)}`;
    }
    return model === assignment.model ? null : `model mismatch: asked for ${assignment.model}, ran ${model}`;
  }
}
