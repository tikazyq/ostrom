export type Harness = "claude" | "codex";
export type Objective = "cost" | "balanced" | "quality";
export interface Model {
  id: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort: string | null;
}
export interface Selection {
  harness: Harness;
  modelId: string;
  efforts: string[];
  approval: boolean;
  cost: number;
  note: string;
}
export interface ModelSettings { objective: Objective; selections: Selection[] }
export interface ModelsView extends ModelSettings {
  catalogs: { harness: Harness; refreshedAt: string; models: Model[] }[];
}

export function harness(value: unknown): Harness {
  if (value !== "claude" && value !== "codex") throw new Error("harness must be claude or codex");
  return value;
}
export function objective(value: unknown): Objective {
  if (value !== "cost" && value !== "balanced" && value !== "quality") throw new Error("objective must be cost, balanced or quality");
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error("expected a string array");
  if (new Set(value).size !== value.length) throw new Error("duplicate efforts");
  return value as string[];
}
