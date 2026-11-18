// Seeds a hung turn in a throwaway store for the idle budget exercise (docs/watchdog.md).
// The running daemon dispatches it normally and can cancel the turn at the configured limit.
//
//   node src/watchdog/scripted-stall.ts <issue-number>
//
// Environment: OSTROM_REPO, OSTROM_ALLOWLIST and OSTROM_DB (use a new file). The daemon's send
// pass updates the supplied issue's status card, so use a sandbox issue.

import { loadBudgetDefaults, type BudgetDefaults } from "../budget/budgets.ts";
import { loadConfig } from "../ostromd/config.ts";
import { Store } from "../store/store.ts";

export const STALL_BRIEF = [
  "This is a scripted stall for Ostrom's Watchdog test. There is nothing to change in this repository:",
  "never commit, push or open a pull request, whatever other instructions say.",
  "Run `sleep 3600` in the shell and wait for it to finish. Do not make edits while it runs.",
  "If Ostrom interrupts the sleep and asks you to save work, finish the turn immediately. There is no work to save.",
].join("\n");

/** Seeds an accepted ticket for normal daemon dispatch; it never starts a Worker session itself. */
export function seedScriptedStall(store: Store, repo: string, actor: string, issue: number, budget?: BudgetDefaults): number {
  const source = store.ensureSource("github", repo);
  const url = `https://github.com/${repo}/issues/${issue}`;
  const threadId = store.ensureThread({ sourceId: source.id, kind: "issue", number: issue, url });
  const trigger = store.insertTrigger({
    sourceId: source.id,
    sourceEventId: `scripted-stall-${Date.now()}`,
    threadId,
    kind: "issue_comment",
    actor,
    url: `${url}#scripted-stall`,
    occurredAt: new Date(),
  });
  const { ticketId } = store.recordDecision({
    threadId,
    triggerIds: [trigger.id],
    verdict: "accept",
    reason: STALL_BRIEF,
  }, budget);
  return ticketId!;
}

async function scriptedStall(issue: number): Promise<void> {
  const config = loadConfig(process.env);
  const store = Store.open(config.dbPath);
  try {
    const ticketId = seedScriptedStall(store, config.repo, config.allowlist[0]!, issue, loadBudgetDefaults(process.env));
    process.stdout.write(`${JSON.stringify({ ticketId })}\n`);
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  const issue = process.argv[2] ?? "";
  if (process.argv.length !== 3 || !/^[1-9]\d*$/.test(issue)) {
    process.stderr.write("usage: node src/watchdog/scripted-stall.ts <issue-number>\n");
    process.exitCode = 2;
  } else {
    try {
      await scriptedStall(Number(issue));
    } catch (error) {
      process.stderr.write(`scripted-stall: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
