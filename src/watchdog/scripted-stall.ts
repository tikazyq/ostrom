// Seeds an accepted ticket in a throwaway store. Start `ostromd run` on that store to dispatch
// the Worker and exercise the watchdog with the same daemon that owns the hung turn.

import { loadBudgetDefaults, loadConfig } from "../ostromd/config.ts";
import { Store } from "../store/store.ts";

const STALL_BRIEF = [
  "This is a scripted Watchdog exercise. In place of normal issue work, run `sleep 3600` in the foreground and wait for it.",
  "Run the same command again on each of Ostrom's two automatic recovery prompts.",
  "When Ostrom asks for the public stuck reply, return the requested JSON promptly without running sleep again.",
  "Do not edit files, push a branch, or open a pull request for this exercise.",
].join(" ");

export function seedScriptedStall(store: Store, config: ReturnType<typeof loadConfig>, issue: number, budget: ReturnType<typeof loadBudgetDefaults>): number {
  const source = store.ensureSource("github", config.repo);
  const url = `https://github.com/${config.repo}/issues/${issue}`;
  const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: issue, url });
  const trigger = store.insertTrigger({
    sourceId: source.id,
    sourceEventId: `scripted-stall-${Date.now()}`,
    threadId,
    kind: "issue_comment",
    actor: config.allowlist[0]!,
    url,
    occurredAt: new Date(),
  });
  return store.recordDecision({ threadId, triggerIds: [trigger.id], verdict: "accept", reason: STALL_BRIEF }, budget).ticketId!;
}

if (import.meta.main) {
  const issue = process.argv[2] ?? "";
  if (process.argv.length !== 3 || !/^[1-9]\d*$/.test(issue)) {
    process.stderr.write("usage: node src/watchdog/scripted-stall.ts <issue-number>\n");
    process.exitCode = 2;
  } else {
    try {
      const config = loadConfig(process.env);
      const budget = loadBudgetDefaults(process.env);
      const store = Store.open(config.dbPath);
      try {
        const ticketId = seedScriptedStall(store, config, Number(issue), budget);
        process.stdout.write(`${JSON.stringify({ ticketId })}\n`);
      } finally {
        store.close();
      }
    } catch (error) {
      process.stderr.write(`scripted-stall: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
