import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { defaultSocketPath, localApi } from "../api/server.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store } from "../store/store.ts";
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

test("models manages selections over the socket and reads or exports them offline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-cli-models-"));
  const path = join(directory, "ostrom.db");
  const file = join(directory, "selections.json");
  const env = { OSTROM_DB: path, HOME: directory, XDG_RUNTIME_DIR: directory };
  const store = Store.open(path);
  const refreshed: string[][] = [];
  const api = localApi(store, {
    socketPath: defaultSocketPath(env),
    control: { pause: async () => {}, resume: async () => {}, stop: async () => {}, extend: async () => {}, preview: async () => "" },
    refreshModels: async (harnesses) => {
      refreshed.push([...(harnesses ?? [])]);
      throw new Error("codex: unavailable");
    },
  });
  const original = process.stdout.write;
  let output = "";
  try {
    const model = { id: "test/model", displayName: "Test", description: "", efforts: ["low", "high"], defaultEffort: "high" };
    const key = `codex/${model.id}`;
    store.saveModelCatalog("codex", [model]);
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
    await api.start();
    assert.equal(await main(["models"], env), 0);
    assert.match(output, /codex\/test\/model  not allowed/);
    assert.equal(await main(["models", "allow", key], env), 0);
    assert.equal(await main(["models", "set", key, "--efforts", "low", "--approval", "true", "--cost", "2.5", "--note", "Rust work"], env), 0);
    assert.equal(await main(["models", "objective", "quality"], env), 0);
    const expected = { objective: "quality", selections: [{ model: key, efforts: ["low"], approval: true, cost: 2.5, note: "Rust work" }] };
    assert.deepEqual(store.modelSelections(), expected);
    assert.equal(await main(["models", "set", key, "--efforts", "max"], env), 1);
    assert.equal(await main(["models", "refresh", "codex"], env), 1);
    assert.deepEqual(refreshed, [["codex"]]);
    writeFileSync(file, JSON.stringify({ objective: "cost", selections: [...expected.selections, { model: "codex/missing" }] }));
    assert.equal(await main(["models", "import", file], env), 1);
    assert.deepEqual(store.modelSelections(), expected);

    store.saveModelCatalog("codex", []);
    output = "";
    assert.equal(await main(["models"], env), 0);
    assert.match(output, /codex\/test\/model  allowed but unavailable/);
    assert.equal(await main(["models", "remove", key], env), 0);
    assert.deepEqual(store.modelSelections().selections, []);
    store.saveModelCatalog("codex", [model]);
    writeFileSync(file, JSON.stringify(expected));
    assert.equal(await main(["models", "import", file], env), 0);
    await api.close();

    output = "";
    assert.equal(await main(["models", "export"], env), 0);
    assert.deepEqual(JSON.parse(output), expected);
    output = "";
    assert.equal(await main(["models", "--json"], env), 0);
    assert.deepEqual(JSON.parse(output).catalogs[0].models, [model]);
    assert.equal(await main(["models", "remove", key], env), 1);
    assert.deepEqual(store.modelSelections(), expected);
  } finally {
    process.stdout.write = original;
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
