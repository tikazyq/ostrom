# The Watchdog and scripted stall

Milestone 1 step 6 (`docs/direction.md`). Each `ostromd run` tick checks running Workers after follow-up routing and before the Router pass. `ostromd dev watchdog` runs a single check.

## Signal

The Watchdog makes one deterministic Semon read:

```sh
semon query stalls --idle-minutes <OSTROM_STALL_MINUTES> --since 1d --json
```

Semon reports sessions waiting on a question, whose process has gone, or which produce no output. Ostrom matches a Worker by its worktree branch, `ostrom/ticket-<ticket>-<assignment>`. A failed Semon read makes the pass fail and does not clear an existing episode.

Between turns, only `waiting-question` counts as a Semon stall. During a turn, a signal counts once the turn itself reaches `OSTROM_STALL_MINUTES`, since Semon's idle clock starts at the session's last write and can predate the turn. In the sandbox, Semon classified a completed Codex exec turn as `ended` even when its final answer said it was waiting for a reply. The scripted exercise therefore keeps a real turn open with a foreground command.

## Recovery and escalation

A stall opens one row. The Watchdog can clear the episode when the signal goes away, for example while a fresh turn is still too young to count as stuck. The two silent recovery attempts belong to the assignment and carry across those episodes. A human follow-up or the end of the assignment resets the counter.

The daemon cancels the in-flight turn before running a recovery or drafting the public stuck reply on the same native session. The replacement takes priority over ordinary queued follow-ups. Graceful stop and issue closure also interrupt the in-flight turn. After two recovery attempts, the next stall pauses the ticket and asks the Worker to draft the one public reply. A human follow-up clears the public episode and resumes the ticket.

## Scripted stall

Use a dedicated issue in the sandbox repository, a fresh database, and a separate daemon socket. This exercise posts the status card and stuck reply to the supplied issue. Use a sandbox checkout with no existing `ostrom/ticket-1-1` branch.

```sh
scratch=$(mktemp -d)
export OSTROM_REPO=onsager-ai/ostrom-sandbox OSTROM_ALLOWLIST='<login>'
export OSTROM_DB="$scratch/ostrom.sqlite" XDG_RUNTIME_DIR="$scratch"
export OSTROM_WORKER_REPO='<sandbox-checkout>' OSTROM_WORKER_BASE=main
export OSTROM_WORKER_WORKTREES="$scratch/worktrees" OSTROM_STALL_MINUTES=2
export OSTROM_WORKER_HARNESS=codex OSTROM_WORKER_MODEL=gpt-6-luna
node src/watchdog/scripted-stall.ts '<sandbox-issue-number>'
node src/ostromd/main.ts run --interval 15
```

The seeder prints the accepted ticket ID. `ostromd` creates the assignment and worktree, starts `sleep 3600` through the Worker brief, and owns the turn for the duration of the exercise. Each recovery turn is asked to run the same command. Allow at least three stall windows and enough time for the reply to be drafted and sent. Check the dispatch log for the native session ID and branch, then verify the issue has one stuck reply and the existing card shows **Stuck**. Stop the daemon and remove the scratch worktree, branch and database after the exercise.
