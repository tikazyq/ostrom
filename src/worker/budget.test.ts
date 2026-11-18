import assert from "node:assert/strict";
import { test } from "node:test";
import { assessBudget } from "./budget.ts";

test("warning starts at 80 percent and the limit is inclusive", () => {
  const limits = { wallMs: 100, idleMs: 100, turns: 10, tokens: 100, escalations: 0 };
  assert.deepEqual(assessBudget(limits, { wallMs: 79, idleMs: 80, turns: 10, tokens: 101 }), {
    warning: ["idleMs", "turns", "tokens"], reached: ["turns", "tokens"],
  });
});
