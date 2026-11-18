import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rolloutModel, rolloutTurn } from "./rollout.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "rollout-"));
}

const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });

test("the model is the latest turn_context in the thread's rollout", () => {
  const dir = root();
  try {
    mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
    writeFileSync(
      join(dir, "2026", "11", "09", "rollout-2026-11-09T01-02-03-thr-1.jsonl"),
      [line("session_meta", { id: "thr-1" }), line("turn_context", { model: "a", other: 1 }), line("turn_context", { model: "gpt-6-luna", effort: "high" })].join("\n") + "\n",
    );
    writeFileSync(join(dir, "2026", "11", "09", "rollout-2026-11-09T01-02-04-thr-2.jsonl"), line("turn_context", { model: "other" }));
    assert.equal(rolloutModel(dir, "thr-1"), "gpt-6-luna");
    assert.deepEqual(rolloutTurn(dir, "thr-1"), { model: "gpt-6-luna", effort: "high" });
    assert.deepEqual(rolloutTurn(dir, "thr-2"), { model: "other", effort: null });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the latest context cannot borrow a model or effort from an earlier turn", () => {
  const dir = root();
  try {
    mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
    const path = join(dir, "2026", "11", "09", "rollout-x-thr-1.jsonl");
    writeFileSync(path, [line("turn_context", { model: "old", effort: "high" }), line("turn_context", { model: "new" })].join("\n"));
    assert.deepEqual(rolloutTurn(dir, "thr-1"), { model: "new", effort: null });
    writeFileSync(path, [line("turn_context", { model: "old" }), line("turn_context", { effort: "low" })].join("\n"));
    assert.throws(() => rolloutTurn(dir, "thr-1"), /no turn model/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("a missing rollout or one with no turn model throws", () => {
  const dir = root();
  try {
    mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
    assert.throws(() => rolloutModel(dir, "thr-1"), /no rollout record/);
    writeFileSync(join(dir, "2026", "11", "09", "rollout-x-thr-1.jsonl"), line("session_meta", { id: "thr-1" }));
    assert.throws(() => rolloutModel(dir, "thr-1"), /no turn model/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
