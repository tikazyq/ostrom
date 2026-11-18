// Native Workers (docs/direction.md, milestone 1 PR 2): each Worker is a Claude Code or Codex
// session started and resumed by ID through the session runner. Turns on one session run one at a
// time; a follow-up queues behind the running turn. Everything here is deterministic.

import { basename, join } from "node:path";

import { turnBudgetReached } from "../budget/budgets.ts";
import { queueStatusCard } from "../github/cards.ts";
import { execGh, ghGet, type GhRunner } from "../github/gh.ts";
import { renderReviewReply } from "../github/review-reply.ts";
import type { WorkerConfig } from "../ostromd/config.ts";
import { rolloutModel } from "../session/rollout.ts";
import type { Runner, Session, TurnResult } from "../session/runner.ts";
import { createWorktree } from "../session/worktree.ts";
import type { Assignment, AssignmentOutcome, NewWorkerTurn, Store, TurnEffect, WorkerTurn } from "../store/store.ts";
import { parseStuckReply, renderStuckReply } from "../watchdog/stuck.ts";
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
  gh?: GhRunner;
  log?: (line: string) => void;
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
          store.atomic(() => {
            store.startNativeAssignment(id, sessionId);
            store.beginTurn(id);
            queueStatusCard(store, ticketId);
          });
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

  /**
   * Persists a turn before waking its session. Side effects that must survive process exit use
   * a stored descriptor. Live-only callbacks stay attached to the row while it is deferred.
   */
  deliver(
    assignmentId: number,
    key: string,
    prompt: string,
    options: Pick<NewWorkerTurn, "kind" | "effect"> | ((turnId: string) => void) = { kind: "work" },
    onComplete?: (result: TurnResult) => void | Promise<void>,
  ): boolean {
    const id = this.#deps.store.enqueueWorkerTurn(assignmentId, {
      key, prompt, ...(typeof options === "function" ? { kind: "work" as const } : options),
    });
    if (id !== null && typeof options === "function") {
      this.#callbacks.set(id, { onStart: options, ...(onComplete === undefined ? {} : { onComplete }) });
    }
    this.#schedule(assignmentId);
    return id !== null;
  }

  isIdle(assignmentId: number): boolean {
    return this.#deps.store.isWorkerIdle(assignmentId);
  }

  reserveMerge(assignmentId: number): boolean {
    return this.#deps.store.reserveMerge(assignmentId);
  }

  releaseMerge(assignmentId: number): void {
    this.#deps.store.releaseMerge(assignmentId);
    this.#schedule(assignmentId);
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
      if (assignment.turnStartedAt !== null) {
        store.recoverWorkerTurn(assignment, INTERRUPTED_PROMPT);
        pass.interrupted.push(assignment.id);
      }
      this.#schedule(assignment.id);
    }
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
    store.atomic(() => this.#finished(id, result));
  }

  #schedule(id: number): void {
    if (this.#stopping || this.#scheduled.has(id)) return;
    this.#scheduled.add(id);
    void this.#enqueue(id, async () => {
      try {
        while (!this.#stopping) {
          const turn = this.#deps.store.startQueuedTurn(id);
          if (turn === null) break;
          await this.#turn(id, turn);
        }
      } finally {
        this.#scheduled.delete(id);
      }
    });
  }

  async #turn(id: number, turn: WorkerTurn): Promise<void> {
    const { store } = this.#deps;
    const assignment = store.getAssignment(id);
    const callbacks = this.#callbacks.get(turn.id);
    const turnId = `${assignment.sessionId}:${turn.number}`;
    const controller = new AbortController();
    this.#inFlight.set(id, controller);
    try {
      if (turn.effect?.kind === "delivery") this.#recordDelivery(id, turnId, turn.effect);
      callbacks?.onStart(turnId);
      const result = await this.#session(assignment).send(turn.prompt, controller.signal);
      if (this.#stopping) return;
      if (result.status === "completed" && !controller.signal.aborted && store.getAssignment(id).state === "running") {
        const effect = turn.effect;
        if (effect?.kind === "stop") await this.#draftPullRequests(assignment);
        if (callbacks?.onComplete !== undefined) await callbacks.onComplete(result);
        store.atomic(() => {
          if (store.getAssignment(id).state === "running") this.#completeEffect(assignment, effect, result.text);
          this.#finished(id, result);
          store.finishQueuedTurn(turn.id);
        });
      } else {
        store.atomic(() => {
          this.#finished(id, result);
          store.finishQueuedTurn(turn.id);
        });
      }
    } catch (error) {
      if (this.#stopping) return;
      store.atomic(() => {
        if (controller.signal.aborted) {
          store.endTurn(id, null);
          store.clearTurnError(id);
        } else {
          this.#failed(id, error);
        }
        store.finishQueuedTurn(turn.id);
      });
    } finally {
      this.#inFlight.delete(id);
      if (!this.#stopping) this.#callbacks.delete(turn.id);
    }
  }

  #recordDelivery(id: number, turnId: string, effect: Extract<TurnEffect, { kind: "delivery" }>): void {
    const { store } = this.#deps;
    store.atomic(() => {
      for (const triggerId of effect.triggerIds) {
        const trigger = store.getTrigger(triggerId);
        store.recordDelivery(triggerId, id, turnId);
        if (trigger.kind !== "pull_request_review") {
          store.enqueueReply({
            id: `${effect.reaction}-${triggerId}`, threadId: trigger.threadId, body: "",
            kind: "reaction", target: trigger.url, reaction: "eyes",
          });
        }
      }
    });
  }

  #completeEffect(assignment: Assignment, effect: TurnEffect | undefined, text: string): void {
    const { store } = this.#deps;
    if (effect === undefined) return;
    if (effect.kind === "stop") {
      store.enqueueReply({ id: effect.replyId, threadId: effect.threadId, body: text, blocking: true });
      store.endAssignment(assignment.id, effect.reason);
      store.endTicket(assignment.ticketId);
      queueStatusCard(store, assignment.ticketId);
    } else if (effect.kind === "stuck-reply") {
      const stall = store.getStall(effect.stallId);
      if (stall.clearedAt !== null) return;
      const body = renderStuckReply(parseStuckReply(text, stall.cause ?? stall.semonReason ?? "unknown"));
      store.enqueueReply({ id: `stuck-${stall.id}`, threadId: store.ticketContext(assignment.ticketId).thread.id, body, blocking: true });
      queueStatusCard(store, assignment.ticketId);
    } else {
      const reviews = effect.kind === "recovered-reviews" ? effect.reviews : effect.review === undefined ? [] : [effect.review];
      for (const review of reviews) {
        store.enqueueReply({ id: `review-${assignment.id}-${review.reviewId}`, threadId: review.threadId, body: renderReviewReply(text) });
      }
    }
  }

  async #draftPullRequests(assignment: Assignment): Promise<void> {
    const gh = this.#deps.gh ?? execGh;
    const repo = this.#deps.store.ticketContext(assignment.ticketId).source.name;
    const owner = repo.split("/")[0]!;
    const response = await ghGet(gh, `repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${assignment.branch!}`)}&state=open&per_page=100`);
    if (!Array.isArray(response)) throw new Error("expected open pull requests");
    for (const pr of response) {
      const url = (pr as { html_url?: unknown }).html_url;
      if (typeof url !== "string") throw new Error("open pull request has no URL");
      if ((pr as { draft?: unknown }).draft !== true) await gh(["pr", "ready", "--undo", url]);
    }
  }

  #failed(id: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#deps.log?.(`assignment ${id}: turn failed: ${message}`);
    this.#deps.store.endTurn(id, null);
    this.#deps.store.recordTurnError(id, message);
    this.#mark(id, "failed");
    queueStatusCard(this.#deps.store, this.#deps.store.getAssignment(id).ticketId);
  }

  #finished(id: number, result: TurnResult): void {
    const { store } = this.#deps;
    store.endTurn(id, result.usage);
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
        `budget-pause-${assignment.turns}`,
        "The ticket budget has been reached. Push your work in progress, then stop and wait for Ostrom to resume you.",
        { kind: "control" },
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
