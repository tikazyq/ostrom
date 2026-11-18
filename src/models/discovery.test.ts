import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { claudeModels, codexModelPage, discoverClaude, discoverCodex, refreshModels } from "./discovery.ts";
import { Store } from "../store/store.ts";
import type { Model } from "./types.ts";
import type { query } from "@anthropic-ai/claude-agent-sdk";

// The Claude projection is checked against the pinned SDK's supportedModels return type.
type ClaudeModel = Awaited<ReturnType<ReturnType<typeof query>["supportedModels"]>>[number];
const claude: Pick<ClaudeModel, "value" | "displayName" | "description" | "supportedEffortLevels"> = {
  value: "sonnet", displayName: "Sonnet", description: "Coding model", supportedEffortLevels: ["low", "high"],
};
const codex = {
  id: "codex", model: "codex", displayName: "Codex", description: "Coding model",
  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Thorough" }],
  defaultReasoningEffort: "high", isDefault: true,
};
const model: Model = { id: "codex", displayName: "Codex", description: "Coding model", efforts: ["low", "high"], defaultEffort: "high" };

test("Claude supportedModels agreement projects model metadata and optional efforts", () => {
  assert.deepEqual(claudeModels([claude]), [{ id: "sonnet", displayName: "Sonnet", description: "Coding model", efforts: ["low", "high"], defaultEffort: null }]);
  assert.deepEqual(claudeModels([{ value: "old", displayName: "Old", description: "No efforts" }])[0]!.efforts, []);
  assert.throws(() => claudeModels([{ id: "wrong" }]), /string/);
});

test("pinned Codex app-server protocol retains the model/list fields consumed by discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ostrom-model-agreement-"));
  try {
    const require = createRequire(import.meta.resolve("@openai/codex-sdk"));
    const cli = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
    await promisify(execFile)(process.execPath, [cli, "app-server", "generate-ts", "--out", directory], { timeout: 15_000 });
    const response = await readFile(join(directory, "v2", "ModelListResponse.ts"), "utf8");
    const model = await readFile(join(directory, "v2", "Model.ts"), "utf8");
    const effort = await readFile(join(directory, "v2", "ReasoningEffortOption.ts"), "utf8");
    const params = await readFile(join(directory, "v2", "ModelListParams.ts"), "utf8");
    for (const field of ["data", "nextCursor"]) assert.match(response, new RegExp(`\\b${field}\\??:`));
    for (const field of ["id", "displayName", "description", "supportedReasoningEfforts", "defaultReasoningEffort"]) assert.match(model, new RegExp(`\\b${field}\\??:`));
    assert.match(effort, /reasoningEffort\??:/);
    assert.match(params, /cursor\??:/);
    assert.match(params, /limit\??:/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Codex model/list agreement projects the experimental paginated shape", () => {
  assert.deepEqual(codexModelPage({ data: [codex], nextCursor: "next" }), { models: [model], nextCursor: "next" });
  assert.throws(() => codexModelPage({ data: [{ ...codex, supportedReasoningEfforts: ["low"] }], nextCursor: null }), /object/);
  assert.throws(() => codexModelPage({ data: [codex], next_cursor: null }), /string/);
  assert.throws(() => codexModelPage({ data: [{ ...codex, defaultReasoningEffort: "max" }], nextCursor: null }), /not supported/);
});

// This is a protocol peer, not a model call. The child asserts initialization order and cursors.
function peer(mode: "pages" | "error" | "exit" | "timeout" | "malformed" | "repeat") {
  return () => spawn(process.execPath, ["--input-type=module", "-e", `
    import { createInterface } from 'node:readline';
    const mode = ${JSON.stringify(mode)};
    const model = ${JSON.stringify(codex)};
    let initialized = false;
    let ready = false;
    let pages = 0;
    const reply = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
    createInterface({input: process.stdin}).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        if (message.params.clientInfo.name !== 'ostrom') process.exit(2);
        initialized = true;
        reply(message.id, {userAgent: 'codex'});
      } else if (message.method === 'initialized') {
        if (!initialized) process.exit(3);
        ready = true;
      } else if (message.method === 'model/list') {
        if (!ready || message.params.cursor !== (pages === 0 ? null : 'next')) process.exit(4);
        if (mode === 'timeout') return;
        if (mode === 'exit') process.exit(5);
        if (mode === 'error') return process.stdout.write(JSON.stringify({id: message.id, error: {code: -1, message: 'discovery refused'}}) + '\\n');
        if (mode === 'malformed') return reply(message.id, {data: [{}], nextCursor: null});
        const entry = {...model, id: pages === 0 ? 'first' : 'second'};
        reply(message.id, {data: [entry], nextCursor: pages === 0 || mode === 'repeat' ? 'next' : null});
        pages++;
      } else process.exit(6);
    });
  `], { stdio: "pipe" });
}

test("Codex discovery initializes, notifies initialized and consumes every page", async () => {
  assert.deepEqual((await discoverCodex(peer("pages"))).map((entry) => entry.id), ["first", "second"]);
});

test("Codex discovery rejects protocol errors, process exit, malformed data, repeated cursors and timeout", async () => {
  await assert.rejects(discoverCodex(peer("error")), /discovery refused/);
  await assert.rejects(discoverCodex(peer("exit")), /exited/);
  await assert.rejects(discoverCodex(peer("malformed")), /supportedReasoningEfforts/);
  await assert.rejects(discoverCodex(peer("repeat")), /repeated a cursor/);
  await assert.rejects(discoverCodex(peer("timeout"), 250), /timed out/);
});

test("Claude discovery closes the query on success and timeout", async () => {
  let closed = 0;
  const run = (() => ({ supportedModels: async () => [claude], close: () => { closed++; } })) as unknown as typeof query;
  assert.equal((await discoverClaude({}, run))[0]!.id, "sonnet");
  const stuck = (() => ({ supportedModels: () => new Promise(() => {}), close: () => { closed++; } })) as unknown as typeof query;
  await assert.rejects(discoverClaude({}, stuck, 5), /timed out/);
  assert.equal(closed, 2);
});

test("failed refresh preserves last good catalog and timestamp while another harness succeeds", async () => {
  const store = Store.open(":memory:", { now: () => new Date("2026-11-18T00:00:00Z") });
  try {
    store.cacheModels("codex", [model]);
    const before = store.models().catalogs[0];
    await assert.rejects(refreshModels(store, { claude: async () => claudeModels([claude]), codex: async () => { throw new Error("offline"); } }), /codex: offline/);
    assert.deepEqual(store.models().catalogs.find((entry) => entry.harness === "codex"), before);
    assert.equal(store.models().catalogs.find((entry) => entry.harness === "claude")!.models[0]!.id, "sonnet");
  } finally { store.close(); }
});
