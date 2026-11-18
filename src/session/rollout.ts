import { closeSync, openSync, readdirSync, readSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How much of the end of a rollout file is read; its records can be large, so this is bounded. */
const TAIL_BYTES = 2 * 1024 * 1024;

export const codexSessionsDir = (): string => join(homedir(), ".codex", "sessions");

/** Reads the latest native turn context, never taking model or effort from another record. */
export function rolloutTurn(root: string, threadId: string, startedAt: string): { model: string | null; effort: string | null } {
  const since = Date.parse(startedAt);
  const path = findRollout(root, threadId);
  const fd = openSync(path, "r");
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString("utf8");
    if (size > length) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"turn_context"')) continue;
    const record = JSON.parse(line) as { type?: unknown; timestamp?: unknown; payload?: { model?: unknown; effort?: unknown } };
    if (record.type !== "turn_context") continue;
    if (typeof record.timestamp !== "string" || !(Date.parse(record.timestamp) >= since)) break;
    const { model, effort } = record.payload ?? {};
    return { model: typeof model === "string" && model !== "" ? model : null, effort: typeof effort === "string" && effort !== "" ? effort : null };
  }
  throw new Error(`rollout ${path} records no context for the current turn`);
}

function findRollout(root: string, threadId: string): string {
  const suffix = `-${threadId}.jsonl`;
  const down = (dir: string) => readdirSync(dir).sort().reverse();
  for (const year of down(root)) {
    for (const month of down(join(root, year))) {
      for (const day of down(join(root, year, month))) {
        const dir = join(root, year, month, day);
        const name = readdirSync(dir).find((file) => file.startsWith("rollout-") && file.endsWith(suffix));
        if (name !== undefined) return join(dir, name);
      }
    }
  }
  throw new Error(`no rollout record for thread ${threadId} under ${root}`);
}
