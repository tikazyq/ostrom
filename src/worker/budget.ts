export const MINUTE_MS = 60_000;

export const DEFAULT_LIMITS = {
  wallMs: 120 * MINUTE_MS,
  idleMs: 30 * MINUTE_MS,
  turns: 40,
  tokens: 2_000_000,
  escalations: 1,
};

export type BudgetLimits = typeof DEFAULT_LIMITS;
export type BudgetMetric = Exclude<keyof BudgetLimits, "escalations">;
export type BudgetUsage = Record<BudgetMetric, number>;
export type BudgetExtension = Partial<Pick<BudgetLimits, "wallMs" | "turns" | "tokens">>;

export const BUDGET_LABEL: Record<BudgetMetric, string> = {
  wallMs: "wall time",
  idleMs: "idle time",
  turns: "turns",
  tokens: "tokens",
};

export function assessBudget(limits: BudgetLimits, usage: BudgetUsage) {
  const metrics = Object.keys(BUDGET_LABEL) as BudgetMetric[];
  return {
    reached: metrics.filter((metric) => usage[metric] >= limits[metric]),
    warning: metrics.filter((metric) => usage[metric] >= 0.8 * limits[metric]),
  };
}
