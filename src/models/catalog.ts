export const HARNESSES = ["claude", "codex"] as const;
export type Harness = typeof HARNESSES[number];

export interface Model {
  id: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort: string | null;
}

export interface Catalog {
  harness: Harness;
  refreshedAt: string;
  models: Model[];
}

export type Objective = "cost" | "balanced" | "quality";

export interface Selection {
  model: string;
  /** Null allows every effort advertised by the harness. */
  efforts: string[] | null;
  approval: boolean;
  cost: number;
  note: string;
}

export interface Selections {
  objective: Objective;
  selections: Selection[];
}

export interface ModelView extends Selections {
  catalogs: Catalog[];
}

export function modelKey(harness: Harness, id: string): string {
  return `${harness}/${id}`;
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}
