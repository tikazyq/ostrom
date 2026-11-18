import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { sessionConfig } from "../session/config.ts";
import type { Store } from "../store/store.ts";
import { HARNESSES, object, type Harness, type Model } from "./catalog.ts";

export type DiscoverModels = (harness: Harness, stop: AbortSignal) => Promise<Model[]>;
const TIMEOUT_MS = 15_000;

export function modelDiscovery(env: Record<string, string | undefined>): DiscoverModels {
  return async (harness, stop) => {
    const { claudeEnv, codex } = sessionConfig(env);
    return harness === "claude"
      ? discoverClaude(claudeEnv, stop)
      : discoverCodex(pinnedCodexCli(), codex.env, env["OSTROM_CODEX_PROVIDER"]?.trim(), stop);
  };
}

// Coalesce startup and explicit refreshes. Each completed harness replaces only its own catalog.
export function modelRefresh(store: Store, discover: DiscoverModels, stop: AbortSignal) {
  const pending = new Map<Harness, Promise<void>>();
  function refreshOne(harness: Harness): Promise<void> {
    const active = pending.get(harness);
    if (active !== undefined) return active;
    const refresh = Promise.resolve().then(async () => {
      stop.throwIfAborted();
      const models = await discover(harness, stop);
      stop.throwIfAborted();
      if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("duplicate model IDs");
      store.saveModelCatalog(harness, models);
    }).finally(() => pending.delete(harness));
    pending.set(harness, refresh);
    return refresh;
  }
  return async (harnesses: readonly Harness[] = HARNESSES): Promise<void> => {
    const results = await Promise.allSettled(harnesses.map(refreshOne));
    const failures = results.flatMap((result, index) => result.status === "fulfilled" ? [] : [
      `${harnesses[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    ]);
    if (failures.length > 0) throw new Error(failures.join("; "));
  };
}

type ClaudeQuery = (input: Parameters<typeof query>[0]) => Pick<ReturnType<typeof query>, "supportedModels" | "close">;

export async function discoverClaude(env: Record<string, string | undefined>, stop: AbortSignal, run: ClaudeQuery = query): Promise<Model[]> {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(TIMEOUT_MS)]);
  signal.throwIfAborted();
  // Keep the SDK input open for the control request without sending a user turn.
  const input = new AbortController();
  const session = run({ prompt: (async function* () {
    if (!input.signal.aborted) await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
  })(), options: { env, abortController: input, persistSession: false } });
  try {
    const models = await untilAborted(signal, () => session.supportedModels());
    return models.map((model) => discoveredModel(model.value, model.displayName, model.description, model.supportedEffortLevels ?? [], null));
  } finally {
    input.abort();
    session.close();
  }
}

export function pinnedCodexCli(): string {
  const require = createRequire(import.meta.resolve("@openai/codex-sdk"));
  return join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

export async function discoverCodex(cli: string, env: NodeJS.ProcessEnv | undefined, provider: string | undefined, stop: AbortSignal,
  timeoutMs = TIMEOUT_MS): Promise<Model[]> {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]);
  signal.throwIfAborted();
  const args = provider ? ["-c", `model_provider=${JSON.stringify(provider)}`] : [];
  const child = spawn(process.execPath, [cli, ...args, "app-server"], { env, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const failed = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`app-server exited (${code ?? signal})`)));
  });
  try {
    return await untilAborted(signal, () => Promise.race([failed, codexCatalog(lines, (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    })]));
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

async function codexCatalog(lines: AsyncIterable<string>, send: (message: object) => void): Promise<Model[]> {
  const responses = lines[Symbol.asyncIterator]();
  let nextId = 0;
  async function request(method: string, params: object): Promise<unknown> {
    const id = ++nextId;
    send({ id, method, params });
    while (true) {
      const line = await responses.next();
      if (line.done) throw new Error(`app-server closed before ${method} replied`);
      const message = object(JSON.parse(line.value));
      if (message["id"] !== id) continue;
      if (message["error"] !== undefined) throw new Error(`${method}: ${JSON.stringify(message["error"])}`);
      if (!("result" in message)) throw new Error(`${method}: missing result`);
      return message["result"];
    }
  }
  await request("initialize", { clientInfo: { name: "ostrom", version: "0.1.0" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  const models: Model[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = object(await request("model/list", { cursor }));
    const data = page["data"];
    const next = page["nextCursor"];
    if (!Array.isArray(data) || (next != null && typeof next !== "string")) throw new Error("invalid model/list page");
    for (const value of data) {
      const model = object(value);
      const efforts = model["supportedReasoningEfforts"];
      const defaultEffort = model["defaultReasoningEffort"];
      if (!Array.isArray(efforts) || typeof defaultEffort !== "string") throw new Error("invalid Codex reasoning efforts");
      models.push(discoveredModel(model["id"], model["displayName"], model["description"],
        efforts.map((effort) => object(effort)["reasoningEffort"]), defaultEffort));
    }
    cursor = next ?? null;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error("model/list repeated a cursor");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return models;
}

function discoveredModel(id: unknown, displayName: unknown, description: unknown, efforts: unknown, defaultEffort: string | null): Model {
  if (typeof id !== "string" || id === "" || typeof displayName !== "string" || typeof description !== "string" ||
    !Array.isArray(efforts) || !efforts.every((effort): effort is string => typeof effort === "string" && effort !== "")) {
    throw new Error("invalid discovered model");
  }
  return { id, displayName, description, efforts, defaultEffort };
}

async function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([aborted, run()]); }
  finally { signal.removeEventListener("abort", abort); }
}
