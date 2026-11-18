import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../store/store.ts";
import type { Model } from "./types.ts";

const model: Model = { id: "model", displayName: "Model", description: "Coding", efforts: ["low", "high"], defaultEffort: "low" };
const key = { harness: "codex", modelId: "model" };

test("catalog, objective and customized selections persist across reopen; discovery never allows models", () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-model-store-"));
  const path = join(directory, "store.db");
  let store = Store.open(path, { now: () => new Date("2026-11-18T00:00:00Z") });
  try {
    assert.equal(store.models().objective, "cost");
    store.cacheModels("codex", [model]);
    assert.deepEqual(store.models().selections, []);
    store.changeModels({ action: "allow", ...key });
    store.changeModels({ action: "set", ...key, settings: { efforts: ["low"], approval: true, cost: 2.5, note: "Rust changes" } });
    store.changeModels({ action: "objective", objective: "balanced" });
    const before = store.models();
    store.close();
    store = Store.open(path);
    assert.deepEqual(store.models(), before);
    assert.deepEqual(before.selections, [{ ...key, efforts: ["low"], approval: true, cost: 2.5, note: "Rust changes" }]);
    assert.equal(before.catalogs[0]!.refreshedAt, "2026-11-18T00:00:00.000Z");
    // A vanished model stays selected, so the operator can see and remove it.
    store.cacheModels("codex", []);
    assert.deepEqual(store.models().selections, before.selections);
    store.changeModels({ action: "remove", ...key });
    assert.deepEqual(store.models().selections, []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("settings validate discovered models and effort subsets; invalid imports change nothing", () => {
  const store = Store.open(":memory:");
  try {
    assert.throws(() => store.changeModels({ action: "allow", ...key }), /not discovered/);
    store.cacheModels("codex", [model]);
    assert.throws(() => store.changeModels({ action: "set", ...key, settings: {} }), /allow the model/);
    store.changeModels({ action: "allow", ...key });
    const before = store.exportModels();
    for (const settings of [{ efforts: ["max"] }, { efforts: [] }, { efforts: ["low", "low"] }, { approval: "true" }, { cost: 0 }, { cost: Infinity }, { note: 12 }, { typo: true }]) {
      assert.throws(() => store.changeModels({ action: "set", ...key, settings }));
      assert.deepEqual(store.exportModels(), before);
    }
    assert.throws(() => store.importModels({ objective: "quality", selections: [...before.selections, { ...before.selections[0], modelId: "unknown" }] }), /not discovered/);
    assert.throws(() => store.importModels({ objective: "quality", selections: [...before.selections, ...before.selections] }), /duplicate/);
    assert.throws(() => store.changeModels({ action: "objective", objective: "fast" }), /objective/);
    assert.deepEqual(store.exportModels(), before);
    store.importModels({ objective: "quality", selections: [] });
    assert.deepEqual(store.exportModels(), { objective: "quality", selections: [] });
    store.importModels(before);
    assert.deepEqual(store.exportModels(), before);
  } finally { store.close(); }
});

test("models without effort controls allow the harness default only", () => {
  const store = Store.open(":memory:");
  try {
    store.cacheModels("claude", [{ ...model, efforts: [], defaultEffort: null }]);
    store.changeModels({ action: "allow", harness: "claude", modelId: model.id });
    assert.deepEqual(store.models().selections[0]!.efforts, []);
    assert.throws(() => store.changeModels({ action: "set", harness: "claude", modelId: model.id, settings: { efforts: ["low"] } }), /subset/);
  } finally { store.close(); }
});
