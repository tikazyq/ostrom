import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseStuckReply, renderStuckReply, stuckDecision } from "./stuck.ts";

const reply = {
  trying: "Choose a default for the status indicator.",
  blockedBy: "The issue and design notes specify different colours.",
  tried: "Checked both sources and retried on the same session.",
  options: ["Use blue as specified in the issue.", "Use grey as specified in the design notes."],
  work: "https://github.com/onsager-ai/ostrom/pull/42",
};

test("the recovery ladder depends on persisted attempts and a settled observation", () => {
  assert.equal(stuckDecision(0, false, true, true), "recover");
  assert.equal(stuckDecision(1, false, true, true), "recover");
  assert.equal(stuckDecision(2, false, true, true), "block");
  assert.equal(stuckDecision(2, false, false, true), "clear");
  assert.equal(stuckDecision(2, false, false, false), "wait");
  assert.equal(stuckDecision(2, true, false, true), "wait");
});

test("the public stuck reply is validated and snapshot-tested", async () => {
  assert.throws(() => parseStuckReply(JSON.stringify({ ...reply, work: " " })), /invalid stuck reply field work/);
  assert.throws(() => parseStuckReply(JSON.stringify({ ...reply, options: ["A", " A "] })), /distinct options/);
  assert.throws(() => parseStuckReply(JSON.stringify({ ...reply, tried: "A\n## B" })), /invalid stuck reply field tried/);
  const snapshot = await readFile(new URL("../github/__snapshots__/stuck-reply.md", import.meta.url), "utf8");
  assert.equal(`${renderStuckReply(parseStuckReply(JSON.stringify(reply)))}\n`, snapshot);
});
