import type { Store } from "../store/store.ts";
import { modelKey, object, type Model, type Objective, type Selection } from "./catalog.ts";

const defaults = { efforts: null, approval: false, cost: 1, note: "" } satisfies Omit<Selection, "model">;

export function changeModels(store: Store, action: "allow" | "remove" | "set" | "objective" | "import", input: unknown): void {
  const body = object(input);
  const { catalogs, ...settings } = store.operatorModels();
  const discovered = new Map(catalogs.flatMap(({ harness, models }) => models.map((model) => [modelKey(harness, model.id), model] as const)));
  const selected = new Map(settings.selections.map((selection) => [selection.model, selection]));
  const offered = (key: string): Model => {
    const model = discovered.get(key);
    if (model === undefined) throw new Error(`model is not in the discovered catalog: ${key}`);
    return model;
  };
  if (action === "objective" || action === "import") {
    settings.objective = objective(body["objective"]);
    if (action === "import") {
      const rows = body["selections"];
      if (!Array.isArray(rows)) throw new Error("expected a selections array");
      selected.clear();
      for (const row of rows) {
        const { model, ...fields } = object(row);
        const key = selectionKey(model);
        if (selected.has(key)) throw new Error(`duplicate selection: ${key}`);
        selected.set(key, { model: key, ...defaults, ...options(fields, offered(key)) });
      }
    }
  } else {
    const { model, ...fields } = body;
    const key = selectionKey(model);
    const current = selected.get(key);
    if (action === "allow") {
      offered(key);
      if (current === undefined) selected.set(key, { model: key, ...defaults });
    } else if (action === "remove") {
      if (current === undefined) offered(key);
      selected.delete(key);
    } else {
      const catalog = offered(key);
      if (current === undefined) throw new Error(`model is not allowed: ${key}`);
      if (Object.keys(fields).length === 0) throw new Error("expected model settings to change");
      selected.set(key, { ...current, ...options(fields, catalog) });
    }
  }
  settings.selections = [...selected.values()].sort((a, b) => a.model.localeCompare(b.model));
  store.saveModelSelections(settings);
}

function selectionKey(value: unknown): string {
  if (typeof value !== "string" || !/^(claude|codex)\/.+$/.test(value)) throw new Error("expected claude/<model> or codex/<model>");
  return value;
}

function objective(value: unknown): Objective {
  if (value !== "cost" && value !== "balanced" && value !== "quality") throw new Error("objective must be cost, balanced or quality");
  return value;
}

function options(input: Record<string, unknown>, model: Model): Partial<Omit<Selection, "model">> {
  const fields: Partial<Omit<Selection, "model">> = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "efforts":
        if (value === null) {
          fields.efforts = null;
        } else {
          if (!Array.isArray(value) || !value.every((effort): effort is string => typeof effort === "string" && model.efforts.includes(effort)) ||
              new Set(value).size !== value.length) {
            throw new Error(`efforts for ${model.id} must be a subset of ${model.efforts.join(", ") || "the empty list"}`);
          }
          fields.efforts = value;
        }
        break;
      case "approval":
        if (typeof value !== "boolean") throw new Error("approval must be true or false");
        fields.approval = value;
        break;
      case "cost":
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("cost must be a positive number");
        fields.cost = value;
        break;
      case "note":
        if (typeof value !== "string") throw new Error("note must be a string");
        fields.note = value;
        break;
      default: throw new Error(`unknown model setting: ${key}`);
    }
  }
  return fields;
}
