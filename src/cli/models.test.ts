import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localApi } from "../api/server.ts";
import { Store } from "../store/store.ts";
import { main } from "./main.ts";
import { parseModels } from "./models.ts";

test("models CLI reads offline, mutates through the socket, and exports/imports JSON", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ostrom-model-cli-"));
  const path = join(directory, "store.db");
  const socketPath = join(directory, "ostrom", "ostromd.sock");
  const env = { OSTROM_DB: path, XDG_RUNTIME_DIR: directory };
  const store = Store.open(path);
  store.cacheModels("codex", [{ id: "model", displayName: "Model", description: "Coding", efforts: ["low", "high"], defaultEffort: "low" }]);
  let refreshes = 0;
  const api = localApi(store, {
    socketPath,
    refreshModels: async () => { refreshes++; throw new Error("discovery failed"); },
    control: { pause: async () => {}, resume: async () => {}, stop: async () => {}, extend: async () => {}, preview: async () => "" },
  });
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await main(["models", "--json"], env), 0);
    assert.equal(JSON.parse(output).catalogs[0].models[0].id, "model");
    assert.equal(await main(["models", "allow", "codex/model"], env), 1);
    assert.deepEqual(store.models().selections, []);
    await api.start();
    assert.equal(await main(["models", "allow", "codex/model"], env), 0);
    assert.equal(await main(["models", "set", "codex/model", "--efforts", "low", "--approval", "true", "--cost", "3", "--note", "Rust"], env), 0);
    assert.equal(await main(["models", "objective", "quality"], env), 0);
    const expected = store.exportModels();
    assert.equal(expected.objective, "quality");
    assert.deepEqual(expected.selections[0], { harness: "codex", modelId: "model", efforts: ["low"], approval: true, cost: 3, note: "Rust" });
    assert.equal(await main(["models", "set", "codex/model", "--efforts", "max"], env), 1);
    assert.deepEqual(store.exportModels(), expected);
    assert.equal(await main(["models", "refresh"], env), 1);
    assert.equal(refreshes, 1);
    const file = join(directory, "models.json");
    writeFileSync(file, JSON.stringify(expected));
    assert.equal(await main(["models", "remove", "codex/model"], env), 0);
    assert.equal(await main(["models", "import", file], env), 0);
    assert.deepEqual(store.exportModels(), expected);
    await api.close();
    output = "";
    assert.equal(await main(["models", "export"], env), 0);
    assert.deepEqual(JSON.parse(output), expected);
    store.cacheModels("codex", []);
    output = "";
    assert.equal(await main(["models"], env), 0);
    assert.match(output, /codex\/model  allowed \(unavailable\)/);
  } finally {
    process.stdout.write = original;
    await api.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("models CLI validates syntax and preserves slashes within model IDs", () => {
  const command = parseModels(["allow", "codex/provider/model"], false);
  assert.deepEqual(command.body, { action: "allow", harness: "codex", modelId: "provider/model" });
  for (const args of [["allow"], ["allow", "other/model"], ["objective", "fast"], ["set", "codex/model", "--approval", "yes"], ["set", "codex/model", "--cost", "0"], ["refresh", "extra"]]) {
    assert.throws(() => parseModels(args, false));
  }
});
