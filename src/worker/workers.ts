// Native Workers (docs/direction.md, milestone 1 PR 2): each Worker is a Claude Code or Codex
// session started and resumed by ID through the session runner. Turns on one session run one at a
// time; a follow-up queues behind the running turn. Everything here is deterministic.

import { join } from "node:path";

import { queueStatusCard } from "../github/cards.ts";
import type { WorkerConfig } from "../ostromd/config.ts";
import { rolloutModel } from "../session/rollout.ts";
import type { Runner, Session, TurnResult } from "../session/runner.ts";
import { createWorktree } from "../session/worktree.ts";
import type { Assignment, AssignmentOutcome, Store } from "../store/store.ts";
import { assessBudget, type BudgetMetric } from "./budget.ts";
import { workerBrief } from "./dispatch.ts";

export const CHECKPOINT_PROMPT = "This ticket reached its budget. Push your work in progress to its existing branch, then stop and wait for Ostrom to resume you.";
export const BUDGET_RESUME_PROMPT = "The operator extended this ticket's budget. Continue from your saved work.";

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
}

/** The main clone's Git directory, where a worktree's commits are written. */
export function gitDir(repo: string): string {
  return join(repo, ".git");
}

export const INTERRUPTED_PROMPT =
  "You were interrupted while working on this ticket. Check your state (git status, your branch and " +
  "pull request) and continue where you stopped.";

export class Workers {
  readonly #deps: WorkersDeps;
  readonly #sessions = new Map<number, Session>();
  readonly #chains = new Map<number, Promise<void>>();
  readonly #queued = new Set<string>();
  readonly #active = new Map<number, AbortController>();
  readonly #budgetStops = new Map<number, BudgetMetric>();

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
        writableDirs: [gitDir(config.repo)],
        onSessionId: (sessionId) => {
          store.startNativeAssignment(id, sessionId);
          store.beginTurn(id);
          queueStatusCard(store, ticketId);
          this.#sessions.set(id, session);
          resolve(sessionId);
        },
      });
      const turn = this.#enqueue(id, () => this.#firstTurn(id, session, workerBrief(context, branch, config.base)));
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
   * Queues a follow-up turn on the assignment's session. `onStart` runs when the turn begins, with
   * the turn's id; that is when the caller records delivery, so a message lost with the queue in a
   * crash is sent again. Returns false when the same key is already queued.
   */
  deliver(
    assignmentId: number,
    key: string,
    prompt: string,
    onStart: (turnId: string, store: Store) => void,
    onComplete?: (result: TurnResult, store: Store) => void | Promise<void>,
    control = false,
  ): boolean {
    if (this.#queued.has(key)) return false;
    this.#queued.add(key);
    void this.#enqueue(assignmentId, () => this.#turn(assignmentId, prompt, (turnId) => {
      onStart(turnId, this.#deps.store);
      this.#queued.delete(key);
    }, onComplete, control)).finally(() => this.#queued.delete(key));
    return true;
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
      if (assignment.turnStartedAt === null) continue;
      store.recordInterruption(assignment.id);
      store.endTurn(assignment.id, null);
      pass.interrupted.push(assignment.id);
      if (store.getTicket(assignment.ticketId).state !== "open") continue;
      if (store.openStall(assignment.id) !== null) store.recordOutcome(assignment.id, "failed");
      else void this.#enqueue(assignment.id, () => this.#turn(assignment.id, INTERRUPTED_PROMPT));
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
        writableDirs: [gitDir(this.#deps.config.repo)],
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

  /** Checks time limits during a live turn as well as between turns. */
  enforceBudget(id: number, idleMs = 0): boolean {
    const { store } = this.#deps;
    const assignment = store.getAssignment(id);
    const ticket = store.getTicket(assignment.ticketId);
    if (ticket.state !== "open" || ticket.budgetResume) return false;
    const { reached } = assessBudget(ticket.budget, store.budgetUsage(ticket.id, idleMs));
    const metric = reached.find((key) => assignment.turnStartedAt === null || key === "wallMs" || key === "idleMs");
    if (metric === undefined) return false;
    if (this.#budgetStops.has(id)) return true;
    this.#budgetStops.set(id, metric);
    this.interrupt(id);
    void this.#enqueue(id, async () => { await this.#checkBudget(id); });
    return true;
  }

  interrupt(id: number): void {
    this.#active.get(id)?.abort();
  }

  resumeBudget(id: number): void {
    const { store } = this.#deps;
    void this.#enqueue(id, async () => {
      if (!store.beginBudgetResume(id)) return;
      await this.#runTurn(id, this.#session(store.getAssignment(id)), BUDGET_RESUME_PROMPT);
      await this.#checkBudget(id);
    });
  }

  recoverStall(id: number, stallId: number, prompt: string, interrupt: boolean, onResult: (result: TurnResult, store: Store) => void): void {
    const { store } = this.#deps;
    const key = `recovery-${id}`;
    if (this.#queued.has(key)) return;
    this.#queued.add(key);
    if (interrupt) this.interrupt(id);
    void this.#enqueue(id, async () => {
      this.#queued.delete(key);
      if (await this.#checkBudget(id) || !store.beginRecovery(stallId)) return;
      const assignment = store.getAssignment(id);
      queueStatusCard(store, assignment.ticketId);
      const result = await this.#runTurn(id, this.#session(assignment), prompt);
      if (result?.status === "completed") onResult(result, store);
      await this.#checkBudget(id);
    });
  }

  async #firstTurn(id: number, session: Session, prompt: string): Promise<void> {
    await this.#runTurn(id, session, prompt);
    await this.#checkBudget(id);
  }

  async #turn(
    id: number,
    prompt: string,
    onStart?: (turnId: string, store: Store) => void,
    onComplete?: (result: TurnResult, store: Store) => void | Promise<void>,
    control = false,
  ): Promise<void> {
    const { store } = this.#deps;
    const assignment = store.getAssignment(id);
    const ticket = store.getTicket(assignment.ticketId);
    if (assignment.state !== "running" || (!control && (ticket.state !== "open" || ticket.budgetResume))) return;
    if (!control && await this.#checkBudget(id)) return;
    const session = this.#session(assignment);
    const turn = store.beginTurn(id);
    onStart?.(`${assignment.sessionId}:${turn}`, store);
    const result = await this.#runTurn(id, session, prompt);
    if (result?.status === "completed") await onComplete?.(result, store);
    await this.#checkBudget(id);
  }

  async #checkBudget(id: number): Promise<boolean> {
    const { store } = this.#deps;
    const assignment = store.getAssignment(id);
    const ticket = store.getTicket(assignment.ticketId);
    const requested = this.#budgetStops.get(id);
    this.#budgetStops.delete(id);
    if (assignment.state !== "running" || ticket.state !== "open" || ticket.budgetResume) return false;
    const metric = requested ?? assessBudget(ticket.budget, store.budgetUsage(ticket.id)).reached[0];
    if (metric === undefined) return false;
    await this.#checkpoint(id, metric);
    return true;
  }

  async #checkpoint(id: number, metric: BudgetMetric): Promise<void> {
    const { store } = this.#deps;
    if (!store.beginBudgetPause(id, metric)) return;
    const assignment = store.getAssignment(id);
    queueStatusCard(store, assignment.ticketId);
    await this.#runTurn(id, this.#session(assignment), CHECKPOINT_PROMPT);
  }

  async #runTurn(id: number, session: Session, prompt: string): Promise<TurnResult | null> {
    const { store } = this.#deps;
    const active = new AbortController();
    this.#active.set(id, active);
    let result: TurnResult;
    try {
      result = await session.send(prompt, active.signal);
    } catch (error) {
      if (store.getAssignment(id).state === "pending") {
        store.abandonAssignment(id, error instanceof Error ? error.message : String(error));
      } else {
        this.#failed(id, error);
      }
      return null;
    } finally {
      this.#active.delete(id);
    }
    this.#finished(id, result);
    return result;
  }

  #failed(id: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#deps.log?.(`assignment ${id}: turn failed: ${message}`);
    this.#deps.store.endTurn(id, null);
    this.#mark(id, "failed");
    queueStatusCard(this.#deps.store, this.#deps.store.getAssignment(id).ticketId);
  }

  #finished(id: number, result: TurnResult): void {
    const { store } = this.#deps;
    store.endTurn(id, result.usage);
    const assignment = store.getAssignment(id);
    if (assignment.state !== "running") return;
    if (result.status === "completed" && assignment.harness === "codex" && this.#deps.codexSessions !== undefined) {
      const reason = this.#modelProblem(assignment, this.#deps.codexSessions);
      if (reason !== null) {
        this.#deps.log?.(`assignment ${id}: ended: ${reason}`);
        store.endAssignment(id, reason);
        return;
      }
    }
    this.#mark(id, result.status === "cancelled" ? "cancelled" : null);
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
