import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../store/store.ts";
import { discoverClaude, discoverCodex, modelRefresh, pinnedCodexCli } from "./discovery.ts";

const stop = new AbortController().signal;

test("Claude discovery reads the pinned supportedModels shape without sending a turn", async () => {
  const fixture = [
    { value: "sonnet", displayName: "Sonnet", description: "A Claude model", supportedEffortLevels: ["low", "high"] },
    { value: "haiku", displayName: "Haiku", description: "Another Claude model" },
  ] satisfies Awaited<ReturnType<ReturnType<typeof query>["supportedModels"]>>;
  let closed = false;
  let input: Promise<IteratorResult<unknown>> | undefined;
  const catalog = await discoverClaude({ EXAMPLE: "env" }, stop, ({ prompt, options }) => {
    assert.equal(options?.env?.["EXAMPLE"], "env");
    assert.equal(options?.persistSession, false);
    assert.notEqual(typeof prompt, "string");
    if (typeof prompt !== "string") input = Promise.resolve(prompt[Symbol.asyncIterator]().next());
    return { supportedModels: async () => fixture, close: () => { closed = true; } };
  });
  assert.deepEqual(catalog, [
    { id: "sonnet", displayName: "Sonnet", description: "A Claude model", efforts: ["low", "high"], defaultEffort: null },
    { id: "haiku", displayName: "Haiku", description: "Another Claude model", efforts: [], defaultEffort: null },
  ]);
  assert.equal(closed, true);
  assert.equal((await input)?.done, true);
});

test("pinned Codex app-server returns the model/list fields Ostrom reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostrom-codex-model-agreement-"));
  try {
    const models = await discoverCodex(pinnedCodexCli(), { PATH: process.env["PATH"], HOME: root, CODEX_HOME: root }, undefined, stop);
    assert.ok(models.length > 0);
    assert.ok(models.some((model) => model.defaultEffort !== null && model.efforts.includes(model.defaultEffort)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex does the stdio handshake, follows cursors and times out a silent server", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostrom-codex-model-pages-"));
  try {
    const cli = join(root, "fake.cjs");
    await writeFile(cli, `
      const assert = require('node:assert/strict');
      assert.deepEqual(process.argv.slice(2), ['-c', 'model_provider="other"', 'app-server']);
      const methods = ['initialize', 'initialized', 'model/list', 'model/list'];
      let step = 0;
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params } = JSON.parse(line);
        assert.equal(method, methods[step++]);
        const reply = (result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
        if (step === 1) {
          assert.equal(params.capabilities.experimentalApi, true);
          reply({});
        } else if (step === 2) {
          assert.equal(id, undefined);
        } else {
          const first = step === 3;
          assert.equal(params.cursor, first ? null : 'next');
          const name = first ? 'one' : 'two';
          reply({ data: [{ id: name, displayName: name, description: 'test',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }], defaultReasoningEffort: 'low' }],
            nextCursor: first ? 'next' : null });
        }
      });
    `);
    const models = await discoverCodex(cli, {}, "other", stop);
    assert.deepEqual(models.map(({ id, efforts, defaultEffort }) => ({ id, efforts, defaultEffort })), [
      { id: "one", efforts: ["low"], defaultEffort: "low" }, { id: "two", efforts: ["low"], defaultEffort: "low" },
    ]);
    const silent = join(root, "silent.cjs");
    await writeFile(silent, "process.stdin.resume();\n");
    await assert.rejects(discoverCodex(silent, {}, undefined, stop, 250), { name: "TimeoutError" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh retains the last good catalog and timestamp for a failing harness", async () => {
  let clock = new Date("2026-11-17T00:00:00Z");
  const store = Store.open(":memory:", { now: () => clock });
  try {
    const model = { id: "one", displayName: "One", description: "test", efforts: ["low"], defaultEffort: "low" };
    const previous = clock.toISOString();
    store.saveModelCatalog("claude", [model]);
    store.saveModelCatalog("codex", [model]);
    clock = new Date("2026-11-18T00:00:00Z");
    const newModel = { ...model, id: "two" };
    const refresh = modelRefresh(store, async (harness) => {
      if (harness === "claude") throw new Error("unavailable");
      return [newModel];
    }, stop);
    await assert.rejects(refresh(), /claude: unavailable/);
    assert.deepEqual(store.operatorModels().catalogs, [
      { harness: "claude", refreshedAt: previous, models: [model] },
      { harness: "codex", refreshedAt: clock.toISOString(), models: [newModel] },
    ]);
  } finally { store.close(); }
});
