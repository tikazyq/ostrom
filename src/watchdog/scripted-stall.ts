// Seed accepted work for the daemon-backed stall exercise (docs/watchdog.md).
// ostromd owns the worktree, session, hung turn and every subsequent recovery turn.

import { loadConfig } from "../ostromd/config.ts";
import { Store } from "../store/store.ts";

export const STALL_BRIEF = [
  "This is a scripted stall for Ostrom's Watchdog test.",
  "For the initial work turn only, run `sleep 3600` as a foreground shell command and wait for it.",
  "Do not edit files, commit, push, or open a pull request for this exercise.",
  "If Ostrom interrupts you with a recovery message, run `sleep 3600` again and wait.",
  "If Ostrom asks for the public stuck reply or a graceful stop, follow that new message instead of sleeping.",
].join("\n");

export function seedScriptedStall(store: Store, repo: string, actor: string, issue: number): number {
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
  return store.recordDecision({
    threadId,
    triggerIds: [trigger.id],
    verdict: "accept",
    reason: STALL_BRIEF,
  }).ticketId!;
}

if (import.meta.main) {
  const issue = process.argv[2] ?? "";
  if (process.argv.length !== 3 || !/^[1-9]\d*$/.test(issue)) {
    process.stderr.write("usage: node src/watchdog/scripted-stall.ts <issue-number>\n");
    process.exitCode = 2;
  } else {
    try {
      const config = loadConfig(process.env);
      const store = Store.open(config.dbPath);
      try {
        const ticketId = seedScriptedStall(store, config.repo, config.allowlist[0]!, Number(issue));
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
