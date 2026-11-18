import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../store/store.ts";
import { allowedModels, chooseEffort, overrideEffort, overrideModel, selectModel } from "./selection.ts";

function fixture(path = ":memory:") {
  const store = Store.open(path);
  const source = store.ensureSource("github", "example/repo");
  const thread = store.ensureThread({ sourceId: source.id, kind: "issue", number: 1, url: "https://example.test/1" });
  const trigger = store.insertTrigger({ sourceId: source.id, sourceEventId: "one", threadId: thread, kind: "issue_comment", actor: "admin", url: "https://example.test/1#comment", occurredAt: new Date() }).id;
  const ticket = store.recordDecision({ threadId: thread, triggerIds: [trigger], verdict: "accept", reason: "fix" }).ticketId!;
  store.models.discovered("codex", ["cheap", "large"].map((id) => ({ harness: "codex", id, displayName: id, description: "", efforts: ["low", "medium", "high"], defaultEffort: "medium" })));
  for (const model of ["cheap", "large"]) store.models.change({ action: "allow", harness: "codex", model });
  store.models.change({ action: "set", harness: "codex", model: "large", cost: 5, approval: true });
  return { store, ticket };
}

test("model choices validate reason and model; invalid or missing choices record the cheapest fallback", () => {
  const { store, ticket } = fixture();
  try {
    for (const [model, reason] of [[undefined, undefined], ["codex/nope", "choice"], ["codex/large", ""]]) {
      selectModel(store, ticket, model, reason);
      assert.equal(store.ticketModel(ticket)?.model, "cheap");
      assert.match(store.modelDecisions(ticket).at(-1)!.reason, /cheapest/);
    }
    selectModel(store, ticket, "codex/large", "Larger task.\nExtra text");
    assert.deepEqual(store.ticketModel(ticket), { harness: "codex", model: "large", reason: "Larger task.", approved: false, effort: null });
    store.models.discovered("codex", []);
    assert.deepEqual(allowedModels(store), []);
  } finally { store.close(); }
});

test("effort choices validate against the selected subset, include history, and fall back on invalid replies", async () => {
  const { store, ticket } = fixture();
  try {
    store.models.change({ action: "set", harness: "codex", model: "cheap", efforts: ["low", "high"] });
    let request = "";
    const choice = await chooseEffort(store, ticket, "codex", "cheap", "conflict", "resolve the conflict", async (text) => {
      request = text;
      return JSON.stringify({ effort: "high", reason: "Resolve overlapping code changes." });
    });
    assert.deepEqual(choice, { effort: "high", reason: "Resolve overlapping code changes." });
    assert.match(request, /conflict/);
    assert.match(request, /history/);
    for (const reply of ['{"effort":"max","reason":"expensive"}', 'null', '{}', 'not JSON']) {
      assert.equal((await chooseEffort(store, ticket, "codex", "cheap", "review", "typo", async () => reply)).effort, "low");
    }
    assert.equal((await chooseEffort(store, ticket, "codex", "cheap", "control", "stop", async () => { throw new Error("offline"); })).effort, "low");
    store.models.change({ action: "set", harness: "codex", model: "cheap", efforts: [] });
    assert.equal((await chooseEffort(store, ticket, "codex", "cheap", "review", "typo")).effort, null);
  } finally { store.close(); }
});

test("overrides persist across restart, approve flagged models and retain effort until changed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-selection-"));
  const path = join(directory, "store.db");
  let { store, ticket } = fixture(path);
  try {
    selectModel(store, ticket, "codex/large", "Complex task.");
    assert.throws(() => overrideModel(store, ticket, "unknown", "operator"), /allowed/);
    overrideModel(store, ticket, "large", "operator");
    overrideEffort(store, { harness: "codex", model: "cheap" }, ticket, "high", "operator");
    assert.throws(() => overrideEffort(store, { harness: "codex", model: "cheap" }, ticket, "max", "operator"), /allowed/);
    store.close();
    store = Store.open(path);
    assert.equal(store.ticketModel(ticket)?.approved, true);
    assert.equal(store.ticketModel(ticket)?.effort, "high");
    overrideModel(store, ticket, "cheap", "operator");
    assert.equal(store.ticketModel(ticket)?.effort, "high");
    const choice = await chooseEffort(store, ticket, "codex", "cheap", "review", "typo", async () => { throw new Error("must not be asked"); });
    assert.equal(choice.effort, "high");
    assert.match(choice.reason, /override/);
    assert.equal(store.modelDecisions(ticket).length, 4);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an effort override arriving during inference wins on that turn", async () => {
  const { store, ticket } = fixture();
  try {
    selectModel(store, ticket, "codex/cheap", "Small task.");
    const choice = await chooseEffort(store, ticket, "codex", "cheap", "review", "review", async () => {
      overrideEffort(store, { harness: "codex", model: "cheap" }, ticket, "high", "operator");
      return '{"effort":"low","reason":"Small change."}';
    });
    assert.equal(choice.effort, "high");
  } finally { store.close(); }
});
