import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rolloutTurn } from "./rollout.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "rollout-"));
}

const startedAt = "2026-11-09T01:02:03.000Z";
const line = (type: string, payload: unknown, timestamp = startedAt) => JSON.stringify({ type, payload, timestamp });

test("the model is the latest turn_context in the thread's rollout", () => {
  const dir = root();
  try {
    mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
    writeFileSync(
      join(dir, "2026", "11", "09", "rollout-2026-11-09T01-02-03-thr-1.jsonl"),
      [line("session_meta", { id: "thr-1" }), line("turn_context", { model: "a", effort: "max" }),
        line("turn_context", { model: "gpt-6-luna", effort: "low" }), line("event_msg", { model: "irrelevant", effort: "high" })].join("\n") + "\n",
    );
    writeFileSync(join(dir, "2026", "11", "09", "rollout-2026-11-09T01-02-04-thr-2.jsonl"), line("turn_context", { model: "other" }));
    assert.deepEqual(rolloutTurn(dir, "thr-1", startedAt), { model: "gpt-6-luna", effort: "low" });
    assert.throws(() => rolloutTurn(dir, "thr-1", "2026-11-09T01:03:00.000Z"), /no context for the current turn/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a missing rollout or one with no turn model throws", () => {
  const dir = root();
  try {
    mkdirSync(join(dir, "2026", "11", "09"), { recursive: true });
    assert.throws(() => rolloutTurn(dir, "thr-1", startedAt), /no rollout record/);
    const path = join(dir, "2026", "11", "09", "rollout-x-thr-1.jsonl");
    writeFileSync(path, line("session_meta", { id: "thr-1" }));
    assert.throws(() => rolloutTurn(dir, "thr-1", startedAt), /no context for the current turn/);
    writeFileSync(path, [line("turn_context", { model: "previous", effort: "high" }), line("turn_context", { effort: "low" }),
      line("event_msg", { model: "not-the-model" })].join("\n"));
    assert.deepEqual(rolloutTurn(dir, "thr-1", startedAt), { model: null, effort: "low" });
  } finally {
    rmSync(dir, { recursive: true });
  }
});
