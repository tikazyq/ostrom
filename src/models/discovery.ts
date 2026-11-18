import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { sessionConfig } from "../session/config.ts";
import type { Store } from "../store/store.ts";
import { object, strings, text, type Harness, type Model } from "./types.ts";

export type Discovery = Record<Harness, () => Promise<Model[]>>;
const TIMEOUT_MS = 30_000;

/** Only the fields consumed here are projected; unknown vendor fields are left alone. */
export function claudeModels(input: unknown): Model[] {
  if (!Array.isArray(input)) throw new Error("Claude supportedModels must return an array");
  return unique(input.map((entry: unknown) => {
    const value = object(entry);
    return { id: text(value["value"]), displayName: text(value["displayName"]), description: text(value["description"]),
      efforts: value["supportedEffortLevels"] === undefined ? [] : strings(value["supportedEffortLevels"]), defaultEffort: null };
  }));
}

export function codexModelPage(input: unknown): { models: Model[]; nextCursor: string | null } {
  const page = object(input);
  if (!Array.isArray(page["data"])) throw new Error("Codex model/list data must be an array");
  const models = page["data"].map((entry: unknown) => {
    const value = object(entry);
    if (!Array.isArray(value["supportedReasoningEfforts"])) throw new Error("missing supportedReasoningEfforts");
    const efforts = strings(value["supportedReasoningEfforts"].map((effort: unknown) => text(object(effort)["reasoningEffort"])));
    const defaultEffort = text(value["defaultReasoningEffort"]);
    if (!efforts.includes(defaultEffort)) throw new Error("default effort is not supported");
    return { id: text(value["id"]), displayName: text(value["displayName"]), description: text(value["description"]), efforts, defaultEffort };
  });
  return { models: unique(models), nextCursor: page["nextCursor"] === null ? null : text(page["nextCursor"]) };
}

function unique(models: Model[]): Model[] {
  if (models.some((model) => model.id === "") || new Set(models.map((model) => model.id)).size !== models.length) throw new Error("empty or duplicate model ID");
  return models;
}

export async function discoverClaude(env: Record<string, string | undefined>, run = query, timeoutMs = TIMEOUT_MS): Promise<Model[]> {
  const abortController = new AbortController();
  const session = run({ prompt: "", options: { env, abortController } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.supportedModels().then(claudeModels),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
        abortController.abort();
        reject(new Error("Claude model discovery timed out"));
      }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    session.close();
  }
}

export type AppServer = () => ChildProcessWithoutNullStreams;

/** Newline-delimited JSON-RPC on the pinned Codex CLI's stdio transport. */
export async function discoverCodex(start: AppServer, timeoutMs = TIMEOUT_MS): Promise<Model[]> {
  const child = start();
  const lines = createInterface({ input: child.stdout });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let terminal: Error | undefined;
  const fail = (error: Error) => {
    terminal = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Codex app-server exited (${code ?? signal})`)));
  // Drain stderr without logging vendor output, which may include local configuration details.
  child.stderr.resume();
  lines.on("line", (line) => {
    try {
      const message = object(JSON.parse(line));
      if (typeof message["id"] !== "number") return; // server notifications/requests
      const waiter = pending.get(message["id"]);
      if (waiter === undefined) return;
      pending.delete(message["id"]);
      if (message["error"] !== undefined) waiter.reject(new Error(`Codex app-server: ${text(object(message["error"])["message"])}`));
      else waiter.resolve(message["result"]);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.on("error", fail);
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (terminal !== undefined) return reject(terminal);
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const timer = setTimeout(() => fail(new Error("Codex model discovery timed out")), timeoutMs);
  try {
    await request("initialize", { clientInfo: { name: "ostrom", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const models: Model[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = codexModelPage(await request("model/list", { cursor, limit: 100 }));
      models.push(...page.models);
      cursor = page.nextCursor;
      if (cursor !== null && cursors.has(cursor)) throw new Error("Codex model/list repeated a cursor");
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
    return unique(models);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

export function discovery(env: Record<string, string | undefined>): Discovery {
  const config = sessionConfig(env);
  return {
    claude: () => discoverClaude(config.claudeEnv),
    codex: () => discoverCodex(() => {
      const require = createRequire(import.meta.resolve("@openai/codex-sdk"));
      const cli = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
      const provider = env["OSTROM_CODEX_PROVIDER"]?.trim();
      const overrides = provider ? ["-c", `model_provider=${JSON.stringify(provider)}`] : [];
      return spawn(process.execPath, [cli, ...overrides, "app-server"], { env: config.codex.env, stdio: "pipe" });
    }),
  };
}

/** Each successful harness commits independently. Failure preserves that harness's last good list. */
export async function refreshModels(store: Store, discover: Discovery): Promise<void> {
  const results = await Promise.allSettled((["claude", "codex"] as const).map(async (harness) => {
    try { store.cacheModels(harness, await discover[harness]()); }
    catch (error) { throw new Error(`${harness}: ${error instanceof Error ? error.message : String(error)}`); }
  }));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) throw new Error(failures.map((result) => String(result.reason)).join("; "));
}
