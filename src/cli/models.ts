import { readFile } from "node:fs/promises";
import type { Store } from "../store/store.ts";
import { harness, objective, type ModelsView } from "../models/types.ts";

export interface ModelsCommand {
  name: "models";
  json: boolean;
  action: "list" | "export" | "import" | "refresh" | "allow" | "remove" | "set" | "objective";
  body?: unknown;
  file?: string;
}

export function parseModels(args: readonly string[], json: boolean): ModelsCommand {
  const [action = "list", ...rest] = args;
  if ((action === "list" || action === "export" || action === "refresh") && rest.length === 0) return { name: "models", action, json };
  if (action === "import" && rest.length === 1) return { name: "models", action, json, file: rest[0]! };
  if (action === "objective" && rest.length === 1) return { name: "models", action, json, body: { action, objective: objective(rest[0]) } };
  if (action !== "allow" && action !== "remove" && action !== "set") throw new Error("invalid models command");
  const key = rest[0] ?? "";
  const slash = key.indexOf("/");
  if (slash < 0 || slash === key.length - 1) throw new Error("expected harness/model-id");
  const body = { action, harness: harness(key.slice(0, slash)), modelId: key.slice(slash + 1) };
  if (action !== "set" && rest.length === 1) return { name: "models", action, json, body };
  if (action !== "set" || rest.length < 3 || rest.length % 2 !== 1) throw new Error("expected model settings as --name value pairs");
  const settings: Record<string, unknown> = {};
  for (let index = 1; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1]!;
    if (flag === "--efforts") settings["efforts"] = value === "" ? [] : value.split(",");
    else if (flag === "--approval" && (value === "true" || value === "false")) settings["approval"] = value === "true";
    else if (flag === "--cost" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0) settings["cost"] = Number(value);
    else if (flag === "--note") settings["note"] = value;
    else throw new Error(`invalid model setting: ${flag}`);
  }
  return { name: "models", action, json, body: { ...body, settings } };
}

export async function modelsApi(command: ModelsCommand, call: (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>): Promise<unknown> {
  if (command.action === "list") return call("GET", "/v1/models");
  if (command.action === "export") return call("GET", "/v1/models/export");
  if (command.action === "refresh") return call("POST", "/v1/models/refresh");
  if (command.action === "import") return call("POST", "/v1/models/import", JSON.parse(await readFile(command.file!, "utf8")));
  return call("POST", "/v1/models", command.body);
}

export function modelsDirect(store: Store, command: ModelsCommand): unknown {
  return command.action === "export" ? store.exportModels() : store.models();
}

export function modelsOutput(command: ModelsCommand, value: unknown): void {
  if (command.json || command.action === "export") {
    process.stdout.write(`${JSON.stringify(value, null, command.action === "export" ? 2 : undefined)}\n`);
    return;
  }
  const view = value as ModelsView;
  process.stdout.write(`objective ${view.objective}\n`);
  for (const catalog of view.catalogs) {
    process.stdout.write(`${catalog.harness} refreshed ${catalog.refreshedAt}\n`);
    for (const model of catalog.models) {
      const selection = view.selections.find((entry) => entry.harness === catalog.harness && entry.modelId === model.id);
      const incompatible = selection?.efforts.some((effort) => !model.efforts.includes(effort)) ?? false;
      process.stdout.write(`${catalog.harness}/${model.id}  ${selection ? "allowed" : "not allowed"}${incompatible ? " (efforts unavailable)" : ""}  ${model.displayName}\n`);
      process.stdout.write(`  ${model.description}\n  efforts: ${model.efforts.join(",") || "harness default"}; default: ${model.defaultEffort ?? "harness default"}\n`);
      if (selection) process.stdout.write(`  selected efforts: ${selection.efforts.join(",") || "harness default"}; approval: ${selection.approval}; cost: ${selection.cost}; note: ${selection.note}\n`);
    }
  }
  for (const selection of view.selections) {
    if (!view.catalogs.find((entry) => entry.harness === selection.harness)?.models.some((model) => model.id === selection.modelId)) {
      process.stdout.write(`${selection.harness}/${selection.modelId}  allowed (unavailable)  efforts: ${selection.efforts.join(",")}; approval: ${selection.approval}; cost: ${selection.cost}; note: ${selection.note}\n`);
    }
  }
}
