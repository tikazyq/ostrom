import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultSocketPath, localApi } from "../api/server.ts";
import { operatorControls } from "../commands/commands.ts";
import { STALL_PAUSE_CAUSE, Store } from "../store/store.ts";
import { FakeRunner } from "../worker/fake-runner.ts";
import { Workers } from "../worker/workers.ts";
import { main } from "./main.ts";

function ticket(path: string): number {
  const store = Store.open(path);
  try {
    const source = store.ensureSource("github", "onsager-ai/ostrom");
    const thread = store.ensureThread({ sourceId: source.id, kind: "issue", number: 1, url: "https://example.test/1" });
    const trigger = store.insertTrigger({
      sourceId: source.id, sourceEventId: "event-1", threadId: thread, kind: "issue_comment", actor: "alice",
      url: "https://example.test/1#comment", occurredAt: new Date(),
    }).id;
    return store.recordDecision({ threadId: thread, triggerIds: [trigger], verdict: "accept", reason: "work" }).ticketId!;
  } finally {
    store.close();
  }
}

test("read-only CLI falls back to the store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-"));
  const path = join(directory, "ostrom.db");
  try {
    const id = ticket(path);
    assert.equal(await main(["tickets", "--json"], { OSTROM_DB: path, HOME: directory }), 0);
    assert.equal(await main(["show", String(id), "--json"], { OSTROM_DB: path, HOME: directory }), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("show renders turn model, effort and kind in text and JSON", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-turn-"));
  const path = join(directory, "ostrom.db");
  const original = process.stdout.write;
  let output = "";
  try {
    const id = ticket(path);
    const store = Store.open(path);
    try {
      const assignment = store.createAssignment(id);
      store.configureNativeAssignment(assignment, { harness: "codex", model: "luna", worktree: "/w", branch: "b", machine: "h" });
      store.startWorkerTurn(assignment, "dispatch", "low");
      store.finishWorkerTurn(assignment, "completed", null, { model: "luna", effort: "low" });
    } finally { store.close(); }
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
    assert.equal(await main(["show", String(id)], { OSTROM_DB: path, HOME: directory }), 0);
    assert.match(output, /turn 1  dispatch  completed  model luna \(requested luna\)  effort low/);
    output = "";
    assert.equal(await main(["show", String(id), "--json"], { OSTROM_DB: path, HOME: directory }), 0);
    const view = JSON.parse(output) as { turns: { kind: string; observedModel: string; observedEffort: string }[] };
    assert.deepEqual(view.turns.map((turn) => [turn.kind, turn.observedModel, turn.observedEffort]), [["dispatch", "luna", "low"]]);
  } finally {
    process.stdout.write = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI resume clears public stalls and only resumes a paused Worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-resume-"));
  const env = { XDG_RUNTIME_DIR: directory };
  const path = join(directory, "ostrom.db");
  const id = ticket(path);
  const store = Store.open(path);
  const runner = new FakeRunner();
  const workers = new Workers({ store, config: { repo: "/repo", base: "main", worktrees: "/wt", harness: "codex", model: "m", machine: "h" },
    runners: { codex: runner, claude: runner } });
  const control = operatorControls(store, workers, async () => "[]", "onsager-ai/ostrom");
  const api = localApi(store, { socketPath: defaultSocketPath(env), control: { ...control, preview: async () => "" } });
  try {
    const assignment = store.createAssignment(id);
    store.configureNativeAssignment(assignment, { harness: "codex", model: "m", worktree: "/w", branch: "b", machine: "h" });
    store.startNativeAssignment(assignment, "s");
    await api.start();
    for (const state of ["paused", "open", "ended"] as const) {
      const stall = store.recordStall({ assignmentId: assignment, semonReason: "waiting-question", detail: null }).id;
      store.publishStall(stall);
      if (state === "paused") store.pauseTicket(id, STALL_PAUSE_CAUSE);
      if (state === "ended") {
        store.endAssignment(assignment, "stopped by operator");
        store.endTicket(id);
      }
      assert.equal(await main(["resume", String(id), "--json"], env), 0);
      await workers.drain();
      assert.equal(store.getTicket(id).state, state === "ended" ? "ended" : "open");
      assert.notEqual(store.getStall(stall).clearedAt, null);
      assert.equal(runner.sessions[0]!.prompts.length, 1);
    }
  } finally {
    await api.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mutating CLI commands require a running daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-"));
  const path = join(directory, "ostrom.db");
  try {
    const id = ticket(path);
    assert.equal(await main(["extend", String(id), "--time", "60"], { OSTROM_DB: path, HOME: directory }), 1);
    const unchanged = Store.open(path);
    try {
      assert.equal(unchanged.ticketBudget(id).timeMinutes, 480);
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
